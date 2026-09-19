import { db } from "./firebase-config.js";
import {
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const tasksCollection = collection(db, "tasks");
const projectsCollection = collection(db, "projects");

let tasks = [];
let projects = [];
let state = {
  project: "all",         // all | <projectId> | "" (tanpa proyek)
  navFilter: "all",       // all | today | active | completed | overdue
  category: "all",        // all | kerja | pribadi | belajar
  priority: "all",        // all | high | medium | low
  search: "",
  sort: "newest",
  expanded: new Set(),    // task ids with subtasks panel open
  subAddOpen: new Set(),  // "taskId:subId" with nested add-row open
  selectMode: false,      // manual multi-select mode for bulk archive
  selected: new Set(),    // task ids selected in selectMode
  editing: null,          // { taskId } atau { taskId, subId } yang teksnya sedang diedit
  editValue: "",          // nilai input edit, disimpan agar tidak hilang saat re-render
};

const ICONS = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  restore: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 0 10h-5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dateStr === today;
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short" }) +
    " " + d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

function deadlineStatus(dateStr) {
  if (!dateStr) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr < today) return "overdue";
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  if (dateStr === today || dateStr === tomorrowStr) return "soon";
  return "normal";
}

function isOverdue(t) {
  return !t.completed && deadlineStatus(t.deadline) === "overdue";
}

const ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000; // auto-arsip 1 hari setelah selesai

function escapeAttr(str) {
  return String(str).replace(/"/g, "&quot;");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CATEGORY_LABELS = { kerja: "Kerja", pribadi: "Pribadi", belajar: "Belajar", bug: "Bug" };
const PRIORITY_LABELS = { high: "Tinggi", medium: "Sedang", low: "Rendah" };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PROJECT_COLORS = ["#0f6e6e", "#16794f", "#8a6208", "#b33a30", "#5b4bb8", "#1d6fa5", "#0d8383", "#a0561f"];

function projColor(i) {
  return PROJECT_COLORS[i % PROJECT_COLORS.length];
}

// ---------- Subtask tree helpers (recursive, unlimited depth) ----------
function addNodeToTree(nodes, parentId, node) {
  if (!parentId) return [...nodes, node];
  return nodes.map((n) =>
    n.id === parentId
      ? { ...n, children: [...(n.children || []), node] }
      : { ...n, children: addNodeToTree(n.children || [], parentId, node) }
  );
}

function toggleNodeInTree(nodes, subId) {
  return nodes.map((n) =>
    n.id === subId
      ? { ...n, completed: !n.completed }
      : { ...n, children: toggleNodeInTree(n.children || [], subId) }
  );
}

function setNodeTextInTree(nodes, subId, text) {
  return nodes.map((n) =>
    n.id === subId
      ? { ...n, text }
      : { ...n, children: setNodeTextInTree(n.children || [], subId, text) }
  );
}

function removeNodeFromTree(nodes, subId) {
  return nodes
    .filter((n) => n.id !== subId)
    .map((n) => ({ ...n, children: removeNodeFromTree(n.children || [], subId) }));
}

function countTree(nodes) {
  let total = 0, done = 0;
  for (const n of nodes || []) {
    total++;
    if (n.completed) done++;
    const c = countTree(n.children || []);
    total += c.total;
    done += c.done;
  }
  return { total, done };
}

// ---------- Progress ----------
function taskProgress(t) {
  if (t.completed) return 100;
  const { total, done } = countTree(t.subtasks || []);
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function meanProgress(list) {
  if (!list.length) return 0;
  return Math.round(list.reduce((sum, t) => sum + taskProgress(t), 0) / list.length);
}

function projectScopedTasks(list) {
  const base = list || tasks.filter((t) => !t.archived);
  if (state.project === "all") return base;
  return base.filter((t) => (t.projectId || "") === state.project);
}

// ---------- DOM refs ----------
const taskListEl = document.getElementById("taskList");
const emptyStateEl = document.getElementById("emptyState");
const taskInput = document.getElementById("taskInput");
const taskProject = document.getElementById("taskProject");
const taskCategory = document.getElementById("taskCategory");
const taskPriority = document.getElementById("taskPriority");
const taskLinkBtn = document.getElementById("taskLinkBtn");
const taskLinkRow = document.getElementById("taskLinkRow");
const taskLinkInput = document.getElementById("taskLinkInput");
const taskDeadlineBtn = document.getElementById("taskDeadlineBtn");
const taskDeadlineRow = document.getElementById("taskDeadlineRow");
const taskDeadlineInput = document.getElementById("taskDeadlineInput");
const addTaskBtn = document.getElementById("addTaskBtn");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const viewTitle = document.getElementById("viewTitle");
const viewSubtitle = document.getElementById("viewSubtitle");
const projectListEl = document.getElementById("projectList");
const addProjectBtn = document.getElementById("addProjectBtn");
const projectAddRow = document.getElementById("projectAddRow");
const projectNameInput = document.getElementById("projectNameInput");
const exportPdfBtn = document.getElementById("exportPdfBtn");
const copyTextBtn = document.getElementById("copyTextBtn");
const copyWaBtn = document.getElementById("copyWaBtn");
const exportModalOverlay = document.getElementById("exportModalOverlay");
const exportModalTitle = document.getElementById("exportModalTitle");
const exportModalSub = document.getElementById("exportModalSub");
const exportModalClose = document.getElementById("exportModalClose");
const exportAllOption = document.getElementById("exportAllOption");
const exportOneOption = document.getElementById("exportOneOption");
const exportProjectPicker = document.getElementById("exportProjectPicker");
const exportProjectSelect = document.getElementById("exportProjectSelect");
const exportProjectConfirmBtn = document.getElementById("exportProjectConfirmBtn");
const importBtn = document.getElementById("importBtn");
const importModalOverlay = document.getElementById("importModalOverlay");
const importModalClose = document.getElementById("importModalClose");
const importTextarea = document.getElementById("importTextarea");
const importProject = document.getElementById("importProject");
const importCategory = document.getElementById("importCategory");
const importPriority = document.getElementById("importPriority");
const importConfirmBtn = document.getElementById("importConfirmBtn");
const selectModeBtn = document.getElementById("selectModeBtn");
const bulkBar = document.getElementById("bulkBar");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");
const bulkCount = document.getElementById("bulkCount");
const bulkCompleteBtn = document.getElementById("bulkCompleteBtn");
const bulkArchiveBtn = document.getElementById("bulkArchiveBtn");
const bulkCancelBtn = document.getElementById("bulkCancelBtn");

let exportMode = "pdf"; // "pdf" | "text"

// ---------- Event bindings ----------
addTaskBtn.addEventListener("click", addTask);
taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addTask();
});

taskLinkBtn.addEventListener("click", () => {
  const showing = taskLinkRow.style.display !== "none";
  taskLinkRow.style.display = showing ? "none" : "block";
  taskLinkBtn.classList.toggle("active", !showing);
  if (!showing) taskLinkInput.focus();
});

taskDeadlineBtn.addEventListener("click", () => {
  const showing = taskDeadlineRow.style.display !== "none";
  taskDeadlineRow.style.display = showing ? "none" : "block";
  taskDeadlineBtn.classList.toggle("active", !showing);
  if (!showing) taskDeadlineInput.focus();
});

searchInput.addEventListener("input", (e) => {
  state.search = e.target.value.trim().toLowerCase();
  render();
});

sortSelect.addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});

document.querySelectorAll(".nav-item[data-filter]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item[data-filter]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.navFilter = btn.dataset.filter;
    render();
  });
});

document.querySelectorAll(".cat-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".cat-item").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.category = btn.dataset.category;
    render();
  });
});

document.querySelectorAll(".chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.priority = btn.dataset.priority;
    render();
  });
});

selectModeBtn.addEventListener("click", () => {
  state.selectMode = !state.selectMode;
  state.selected.clear();
  selectModeBtn.classList.toggle("active", state.selectMode);
  render();
});

selectAllCheckbox.addEventListener("click", () => {
  const visibleIds = getFilteredTasks().map((t) => t.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  if (allSelected) {
    visibleIds.forEach((id) => state.selected.delete(id));
  } else {
    visibleIds.forEach((id) => state.selected.add(id));
  }
  render();
});

bulkCancelBtn.addEventListener("click", () => {
  state.selectMode = false;
  state.selected.clear();
  selectModeBtn.classList.remove("active");
  render();
});

bulkCompleteBtn.addEventListener("click", async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  bulkCompleteBtn.disabled = true;
  try {
    await Promise.all(
      ids.map((id) =>
        updateDoc(doc(db, "tasks", id), { completed: true, completedAt: Date.now() })
      )
    );
  } finally {
    bulkCompleteBtn.disabled = false;
    state.selectMode = false;
    state.selected.clear();
    selectModeBtn.classList.remove("active");
    render();
  }
});

bulkArchiveBtn.addEventListener("click", async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  bulkArchiveBtn.disabled = true;
  try {
    await Promise.all(
      ids.map((id) => {
        const t = tasks.find((t) => t.id === id);
        return updateDoc(doc(db, "tasks", id), {
          archived: true,
          completedAt: t && t.completedAt ? t.completedAt : Date.now(),
        });
      })
    );
  } finally {
    bulkArchiveBtn.disabled = false;
    state.selectMode = false;
    state.selected.clear();
    selectModeBtn.classList.remove("active");
    render();
  }
});

exportPdfBtn.addEventListener("click", () => openExportModal("pdf"));
copyTextBtn.addEventListener("click", () => openExportModal("text"));
copyWaBtn.addEventListener("click", () => openExportModal("wa"));

const EXPORT_MODAL_COPY = {
  pdf: ["Export Laporan PDF", "Pilih cakupan laporan yang ingin diexport."],
  text: ["Salin Daftar Tugas sebagai Teks", "Pilih cakupan tugas yang ingin disalin sebagai teks."],
  wa: ["Salin untuk WhatsApp", "Pilih cakupan tugas yang ingin disalin dengan format WhatsApp."],
};

function openExportModal(mode) {
  exportMode = mode;
  const [title, sub] = EXPORT_MODAL_COPY[mode];
  exportModalTitle.textContent = title;
  exportModalSub.textContent = sub;
  exportProjectSelect.innerHTML = projects
    .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
    .join("");
  const noProjCount = tasks.filter((t) => !t.projectId).length;
  if (noProjCount) {
    exportProjectSelect.innerHTML += `<option value="">Tanpa Proyek</option>`;
  }
  exportProjectPicker.style.display = "none";
  exportModalOverlay.classList.add("show");
}

function closeExportModal() {
  exportModalOverlay.classList.remove("show");
  exportProjectPicker.style.display = "none";
}

exportModalClose.addEventListener("click", closeExportModal);
exportModalOverlay.addEventListener("click", (e) => {
  if (e.target === exportModalOverlay) closeExportModal();
});

exportAllOption.addEventListener("click", () => {
  closeExportModal();
  runExport("all");
});

function runExport(target) {
  if (exportMode === "text") copyTasksAsText(target);
  else if (exportMode === "wa") copyTasksAsWhatsApp(target);
  else exportPdf(target);
}

exportOneOption.addEventListener("click", () => {
  if (!projects.length) {
    alert("Belum ada proyek untuk diexport. Buat proyek terlebih dahulu.");
    return;
  }
  exportProjectConfirmBtn.textContent = exportMode === "pdf" ? "Export" : "Salin";
  exportProjectPicker.style.display = "flex";
});

exportProjectConfirmBtn.addEventListener("click", () => {
  const target = exportProjectSelect.value;
  closeExportModal();
  runExport(target);
});

// ---------- Import from text ----------
importBtn.addEventListener("click", openImportModal);
importModalClose.addEventListener("click", closeImportModal);
importModalOverlay.addEventListener("click", (e) => {
  if (e.target === importModalOverlay) closeImportModal();
});

function openImportModal() {
  const current = importProject.value;
  importProject.innerHTML =
    `<option value="">Tanpa Proyek</option>` +
    projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  if ([...importProject.options].some((o) => o.value === current)) importProject.value = current;
  if (state.project !== "all" && projects.some((p) => p.id === state.project)) {
    importProject.value = state.project;
  }
  importTextarea.value = "";
  importModalOverlay.classList.add("show");
  importTextarea.focus();
}

function closeImportModal() {
  importModalOverlay.classList.remove("show");
}

importConfirmBtn.addEventListener("click", async () => {
  const lines = importTextarea.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    alert("Tempel dulu daftar tugasnya, satu tugas per baris.");
    return;
  }

  const projectId = importProject.value;
  const category = importCategory.value;
  const priority = importPriority.value;
  const baseNow = Date.now();
  const todayStr = new Date(baseNow).toISOString().slice(0, 10);

  importConfirmBtn.disabled = true;
  importConfirmBtn.textContent = `Mengimport ${lines.length} tugas...`;
  try {
    await Promise.all(
      lines.map((text, i) =>
        addDoc(tasksCollection, {
          text,
          projectId,
          category,
          priority,
          dueDate: todayStr,
          link: "",
          deadline: "",
          completed: false,
          completedAt: null,
          archived: false,
          subtasks: [],
          createdAt: baseNow + i,
        })
      )
    );
    closeImportModal();
  } catch (err) {
    alert("Gagal mengimport sebagian atau semua tugas. Coba lagi.");
  } finally {
    importConfirmBtn.disabled = false;
    importConfirmBtn.textContent = "Import";
  }
});

// ---------- Projects ----------
addProjectBtn.addEventListener("click", () => {
  const showing = projectAddRow.style.display !== "none";
  projectAddRow.style.display = showing ? "none" : "block";
  if (!showing) projectNameInput.focus();
});

projectNameInput.addEventListener("keydown", async (e) => {
  if (e.key === "Escape") {
    projectAddRow.style.display = "none";
    projectNameInput.value = "";
    return;
  }
  if (e.key !== "Enter") return;
  const name = projectNameInput.value.trim();
  if (!name) return;
  projectNameInput.value = "";
  projectAddRow.style.display = "none";
  const ref = await addDoc(projectsCollection, { name, createdAt: Date.now() });
  state.project = ref.id;
  render();
});

projectListEl.addEventListener("click", (e) => {
  const del = e.target.closest("[data-del-project]");
  if (del) {
    e.stopPropagation();
    deleteProject(del.dataset.delProject);
    return;
  }
  const btn = e.target.closest("[data-project]");
  if (!btn) return;
  state.project = btn.getAttribute("data-project");
  if (state.project !== "all") taskProject.value = state.project;
  render();
});

async function deleteProject(id) {
  const p = projects.find((p) => p.id === id);
  if (!p) return;
  const projTasks = tasks.filter((t) => t.projectId === id);
  const suffix = projTasks.length ? ` beserta ${projTasks.length} tugasnya` : "";
  if (!confirm(`Hapus proyek "${p.name}"${suffix}?`)) return;
  for (const t of projTasks) {
    await deleteDoc(doc(db, "tasks", t.id));
  }
  await deleteDoc(doc(db, "projects", id));
  if (state.project === id) state.project = "all";
}

function renderProjects() {
  const activeTasks = tasks.filter((t) => !t.archived);
  const counts = {};
  activeTasks.forEach((t) => {
    const pid = t.projectId || "";
    counts[pid] = (counts[pid] || 0) + 1;
  });

  let html = `
    <button class="nav-item proj-item ${state.project === "all" ? "active" : ""}" data-project="all">
      <span class="nav-icon">▤</span>
      <span class="proj-name">Semua Proyek</span>
      <span class="proj-count">${activeTasks.length}</span>
    </button>`;

  projects.forEach((p, i) => {
    const scoped = activeTasks.filter((t) => t.projectId === p.id);
    const pct = meanProgress(scoped);
    html += `
    <button class="nav-item proj-item ${state.project === p.id ? "active" : ""}" data-project="${p.id}">
      <span class="cat-dot" style="background:${projColor(i)}"></span>
      <span class="proj-name" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</span>
      <span class="proj-pct">${pct}%</span>
      <span class="proj-del" data-del-project="${p.id}" title="Hapus proyek">🗑</span>
    </button>`;
  });

  if (counts[""]) {
    html += `
    <button class="nav-item proj-item ${state.project === "" ? "active" : ""}" data-project="">
      <span class="cat-dot" style="background:#6b7280"></span>
      <span class="proj-name">Tanpa Proyek</span>
      <span class="proj-count">${counts[""]}</span>
    </button>`;
  }

  projectListEl.innerHTML = html;
}

function populateTaskProjectSelect() {
  const current = taskProject.value;
  taskProject.innerHTML =
    `<option value="">Tanpa Proyek</option>` +
    projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  if ([...taskProject.options].some((o) => o.value === current)) taskProject.value = current;
  if (state.project !== "all" && projects.some((p) => p.id === state.project)) {
    taskProject.value = state.project;
  }
}

function updateViewTitle() {
  const map = {
    all: ["Semua Tugas", "Kelola semua tugasmu di satu tempat"],
    today: ["Hari Ini", "Tugas dengan tenggat waktu hari ini"],
    active: ["Belum Selesai", "Tugas yang masih perlu dikerjakan"],
    completed: ["Selesai", "Tugas yang sudah kamu selesaikan"],
    overdue: ["Terlambat", "Tugas yang sudah lewat deadline"],
    archived: ["Arsip", "Tugas selesai yang sudah diarsipkan otomatis (1 hari setelah selesai)"],
  };
  let [title, subtitle] = map[state.navFilter];

  if (state.project !== "all") {
    const p = projects.find((p) => p.id === state.project);
    const pname = p ? p.name : "Tanpa Proyek";
    title = state.navFilter === "all" ? pname : `${pname} — ${map[state.navFilter][0]}`;
    const scoped = projectScopedTasks();
    subtitle = `Proyek • ${scoped.length} tugas • ${meanProgress(scoped)}% progres`;
  }

  viewTitle.textContent = title;
  viewSubtitle.textContent = subtitle;
}

// ---------- Core actions ----------
async function addTask() {
  const text = taskInput.value.trim();
  if (!text) return;

  const now = Date.now();
  await addDoc(tasksCollection, {
    text,
    projectId: taskProject.value,
    category: taskCategory.value,
    priority: taskPriority.value,
    dueDate: new Date(now).toISOString().slice(0, 10),
    link: taskLinkInput.value.trim(),
    deadline: taskDeadlineInput.value || "",
    completed: false,
    completedAt: null,
    archived: false,
    subtasks: [],
    createdAt: now,
  });

  taskInput.value = "";
  taskLinkInput.value = "";
  taskLinkRow.style.display = "none";
  taskLinkBtn.classList.remove("active");
  taskDeadlineInput.value = "";
  taskDeadlineRow.style.display = "none";
  taskDeadlineBtn.classList.remove("active");
}

async function toggleTask(id) {
  const t = tasks.find((t) => t.id === id);
  if (!t) return;
  const completed = !t.completed;
  await updateDoc(doc(db, "tasks", id), {
    completed,
    completedAt: completed ? Date.now() : null,
    archived: completed ? !!t.archived : false,
  });
}

async function deleteTask(id) {
  await deleteDoc(doc(db, "tasks", id));
}

async function restoreTask(id) {
  // autoArchive:false agar tugas yang sengaja dikembalikan tidak langsung terarsip lagi
  await updateDoc(doc(db, "tasks", id), { archived: false, autoArchive: false });
}

async function autoArchiveOldTasks() {
  const now = Date.now();
  for (const t of tasks) {
    if (!t.completed || t.archived || t.autoArchive === false) continue;
    if (!t.completedAt) {
      // tugas selesai dari sebelum fitur arsip ada — arsipkan langsung
      await updateDoc(doc(db, "tasks", t.id), { completedAt: now - ARCHIVE_AFTER_MS, archived: true });
    } else if (now - t.completedAt >= ARCHIVE_AFTER_MS) {
      await updateDoc(doc(db, "tasks", t.id), { archived: true });
    }
  }
}

function startEdit(taskId, subId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;
  let current = t.text;
  if (subId) {
    const node = findNodeInTree(t.subtasks || [], subId);
    if (!node) return;
    current = node.text;
    state.expanded.add(taskId);
  }
  state.editing = subId ? { taskId, subId } : { taskId };
  state.editValue = current;
  render();
}

function findNodeInTree(nodes, subId) {
  for (const n of nodes) {
    if (n.id === subId) return n;
    const found = findNodeInTree(n.children || [], subId);
    if (found) return found;
  }
  return null;
}

function cancelEdit() {
  state.editing = null;
  state.editValue = "";
  render();
}

async function saveEdit() {
  const edit = state.editing;
  if (!edit) return;
  const text = state.editValue.trim();
  const t = tasks.find((t) => t.id === edit.taskId);

  // dibersihkan lebih dulu supaya blur setelah re-render tidak menyimpan dua kali
  state.editing = null;
  state.editValue = "";

  if (!t || !text) {
    render();
    return;
  }

  if (edit.subId) {
    const node = findNodeInTree(t.subtasks || [], edit.subId);
    if (node && node.text !== text) {
      await updateDoc(doc(db, "tasks", t.id), {
        subtasks: setNodeTextInTree(t.subtasks || [], edit.subId, text),
      });
      return;
    }
  } else if (t.text !== text) {
    await updateDoc(doc(db, "tasks", t.id), { text });
    return;
  }
  render();
}

function toggleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
}

async function addSubtask(taskId, parentId, text, link) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t || !text.trim()) return;
  const node = { id: uid(), text: text.trim(), link: (link || "").trim(), completed: false, children: [] };
  const subtasks = addNodeToTree(t.subtasks || [], parentId, node);
  await updateDoc(doc(db, "tasks", taskId), { subtasks });
}

async function toggleSubtask(taskId, subId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;
  const subtasks = toggleNodeInTree(t.subtasks || [], subId);
  await updateDoc(doc(db, "tasks", taskId), { subtasks });
}

async function deleteSubtask(taskId, subId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;
  const subtasks = removeNodeFromTree(t.subtasks || [], subId);
  await updateDoc(doc(db, "tasks", taskId), { subtasks });
}

// ---------- Filtering / sorting ----------
function getFilteredTasks() {
  let list = (
    state.navFilter === "archived"
      ? projectScopedTasks(tasks.filter((t) => t.archived))
      : projectScopedTasks()
  ).slice();

  if (state.navFilter === "today") list = list.filter((t) => isToday(t.dueDate));
  if (state.navFilter === "active") list = list.filter((t) => !t.completed);
  if (state.navFilter === "completed") list = list.filter((t) => t.completed);
  if (state.navFilter === "overdue") list = list.filter((t) => isOverdue(t));

  if (state.category !== "all") list = list.filter((t) => t.category === state.category);
  if (state.priority !== "all") list = list.filter((t) => t.priority === state.priority);

  if (state.search) {
    list = list.filter((t) => t.text.toLowerCase().includes(state.search));
  }

  switch (state.sort) {
    case "oldest":
      list.sort((a, b) => a.createdAt - b.createdAt);
      break;
    case "priority":
      list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      break;
    case "due":
      list.sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
      break;
    default: // newest
      list.sort((a, b) => b.createdAt - a.createdAt);
  }

  return list;
}

// ---------- Rendering ----------
function render() {
  if (state.navFilter === "archived" && state.selectMode) {
    state.selectMode = false;
    state.selected.clear();
    selectModeBtn.classList.remove("active");
  }
  selectModeBtn.style.display = state.navFilter === "archived" ? "none" : "";
  renderProjects();
  populateTaskProjectSelect();
  updateViewTitle();
  renderStats();
  renderTasks();
  updateBulkBar();
}

function updateBulkBar() {
  const n = state.selected.size;
  bulkBar.style.display = state.selectMode ? "flex" : "none";
  bulkCount.textContent = `${n} dipilih`;
  bulkArchiveBtn.disabled = n === 0;
  bulkCompleteBtn.disabled = n === 0;

  const visibleIds = getFilteredTasks().map((t) => t.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  selectAllCheckbox.classList.toggle("checked", allSelected);
  selectAllCheckbox.innerHTML = allSelected ? ICONS.check : "";
}

function renderStats() {
  const scoped = projectScopedTasks();
  const total = scoped.length;
  const done = scoped.filter((t) => t.completed).length;
  const active = total - done;
  const progress = meanProgress(scoped);

  document.getElementById("statTotal").textContent = total;
  document.getElementById("statActive").textContent = active;
  document.getElementById("statDone").textContent = done;
  document.getElementById("statProgress").textContent = progress + "%";

  document.getElementById("sidebarProgressFill").style.width = progress + "%";
  document.getElementById("sidebarProgressText").textContent = progress + "% selesai";
}

function renderSubtree(taskId, nodes, depth) {
  let html = "";
  (nodes || []).forEach((s) => {
    const addKey = taskId + ":" + s.id;
    const isEditing =
      state.editing && state.editing.taskId === taskId && state.editing.subId === s.id;
    html += `
      <div class="subtask-item" style="margin-left:${depth * 22}px">
        <button class="subtask-checkbox ${s.completed ? "checked" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="toggle-sub">${s.completed ? ICONS.check : ""}</button>
        ${isEditing
          ? `<input class="task-edit-input sub" type="text" value="${escapeAttr(state.editValue)}" data-edit="1" />`
          : `<span class="subtask-text ${s.completed ? "done" : ""}">${escapeHtml(s.text)}</span>`}
        ${s.link ? `<a class="link-badge" href="${escapeAttr(s.link)}" target="_blank" rel="noopener noreferrer">🔗 Link</a>` : ""}
        <button class="task-action-btn edit" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="edit-sub" title="Ubah teks">${ICONS.edit}</button>
        <button class="task-action-btn addsub ${state.subAddOpen.has(addKey) ? "open" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="add-sub-toggle" title="Tambah sub-tugas di dalamnya">${ICONS.plus}</button>
        <button class="task-action-btn delete" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="delete-sub" title="Hapus">${ICONS.trash}</button>
      </div>`;
    if (state.subAddOpen.has(addKey)) {
      html += renderSubAddRow(taskId, s.id, depth + 1);
    }
    html += renderSubtree(taskId, s.children, depth + 1);
  });
  return html;
}

function renderSubAddRow(taskId, parentId, depth) {
  return `
    <div class="subtask-add" style="margin-left:${depth * 22}px">
      <input type="text" class="subtask-input" placeholder="Tambah sub-tugas..." data-task-id="${taskId}" data-parent-id="${parentId}" />
      <button type="button" class="subtask-link-btn" data-task-id="${taskId}" data-parent-id="${parentId}" title="Tambah link">🔗</button>
      <input type="url" class="subtask-link-input" placeholder="https://..." data-task-id="${taskId}" data-parent-id="${parentId}" style="display:none;" />
    </div>`;
}

function renderTasks() {
  const list = getFilteredTasks();
  taskListEl.innerHTML = "";

  if (list.length === 0) {
    emptyStateEl.classList.add("show");
    return;
  }
  emptyStateEl.classList.remove("show");

  list.forEach((t) => {
    const subtasks = t.subtasks || [];
    const { total: subTotal, done: subDone } = countTree(subtasks);
    const isExpanded = state.expanded.has(t.id);
    const pct = taskProgress(t);
    const proj = projects.find((p) => p.id === t.projectId);

    const wrap = document.createElement("div");
    wrap.className = "task-wrap";

    const isSelected = state.selected.has(t.id);
    const isEditing = state.editing && state.editing.taskId === t.id && !state.editing.subId;
    const item = document.createElement("div");
    item.className = "task-item" + (t.completed ? " completed" : "") + (isSelected ? " selected" : "");

    item.innerHTML = `
      ${state.selectMode ? `<button class="select-checkbox ${isSelected ? "checked" : ""}" data-id="${t.id}" data-action="select">${isSelected ? ICONS.check : ""}</button>` : ""}
      <button class="task-checkbox ${t.completed ? "checked" : ""}" data-id="${t.id}" data-action="toggle">${t.completed ? ICONS.check : ""}</button>
      <div class="task-body">
        ${isEditing
          ? `<input class="task-edit-input" type="text" value="${escapeAttr(state.editValue)}" data-edit="1" />`
          : `<div class="task-text"></div>`}
        <div class="task-meta">
          ${proj && state.project === "all" ? `<span class="task-badge badge-project">📁 ${escapeHtml(proj.name)}</span>` : ""}
          <span class="task-badge badge-${t.category}">${CATEGORY_LABELS[t.category]}</span>
          <span class="task-badge" style="background:transparent;padding:0;gap:5px;">
            <span class="priority-dot priority-${t.priority}"></span>${PRIORITY_LABELS[t.priority]}
          </span>
          ${t.dueDate ? `<span class="task-date">📅 ${formatDateTime(t.createdAt)}</span>` : ""}
          ${subTotal ? `<span class="task-date">${subDone}/${subTotal} sub-tugas</span>` : ""}
          ${t.link ? `<a class="link-badge" href="${escapeAttr(t.link)}" target="_blank" rel="noopener noreferrer">🔗 Link</a>` : ""}
          ${t.deadline ? `<span class="deadline-badge deadline-${deadlineStatus(t.deadline)}">⏰ ${formatDate(t.deadline)}</span>` : ""}
        </div>
        <div class="task-progress">
          <div class="task-progress-track"><div class="task-progress-fill ${pct === 100 ? "full" : ""}" style="width:${pct}%"></div></div>
          <span class="task-progress-pct">${pct}%</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="task-action-btn edit" data-id="${t.id}" data-action="edit" title="Ubah teks tugas">${ICONS.edit}</button>
        ${state.navFilter === "archived"
          ? `<button class="task-action-btn restore" data-id="${t.id}" data-action="restore" title="Kembalikan dari arsip">${ICONS.restore}</button>`
          : `<button class="task-action-btn expand ${isExpanded ? "open" : ""}" data-id="${t.id}" data-action="expand" title="Sub-tugas">${ICONS.chevron}</button>`}
        <button class="task-action-btn delete" data-id="${t.id}" data-action="delete" title="Hapus">${ICONS.trash}</button>
      </div>
    `;

    if (!isEditing) item.querySelector(".task-text").textContent = t.text;
    wrap.appendChild(item);

    if (isExpanded) {
      const panel = document.createElement("div");
      panel.className = "subtask-panel";
      panel.innerHTML = renderSubtree(t.id, subtasks, 0) + renderSubAddRow(t.id, "", 0);
      wrap.appendChild(panel);
    }

    taskListEl.appendChild(wrap);
  });

  if (state.editing) {
    const input = taskListEl.querySelector('[data-edit="1"]');
    if (input && document.activeElement !== input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
}

taskListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "select") {
    const id = btn.dataset.id;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
    return;
  }
  if (action === "edit") {
    startEdit(btn.dataset.id, null);
    return;
  }
  if (action === "edit-sub") {
    startEdit(btn.dataset.taskId, btn.dataset.subId);
    return;
  }
  if (action === "toggle") toggleTask(btn.dataset.id);
  if (action === "delete") deleteTask(btn.dataset.id);
  if (action === "expand") toggleExpand(btn.dataset.id);
  if (action === "restore") restoreTask(btn.dataset.id);
  if (action === "toggle-sub") toggleSubtask(btn.dataset.taskId, btn.dataset.subId);
  if (action === "delete-sub") deleteSubtask(btn.dataset.taskId, btn.dataset.subId);
  if (action === "add-sub-toggle") {
    const key = btn.dataset.taskId + ":" + btn.dataset.subId;
    if (state.subAddOpen.has(key)) state.subAddOpen.delete(key);
    else state.subAddOpen.add(key);
    render();
    const input = taskListEl.querySelector(
      `.subtask-input[data-task-id="${btn.dataset.taskId}"][data-parent-id="${btn.dataset.subId}"]`
    );
    if (input) input.focus();
  }
});

taskListEl.addEventListener("click", (e) => {
  const linkBtn = e.target.closest(".subtask-link-btn");
  if (!linkBtn) return;
  const taskId = linkBtn.dataset.taskId;
  const parentId = linkBtn.dataset.parentId || "";
  const linkInput = taskListEl.querySelector(
    `.subtask-link-input[data-task-id="${taskId}"][data-parent-id="${parentId}"]`
  );
  if (!linkInput) return;
  const showing = linkInput.style.display !== "none";
  linkInput.style.display = showing ? "none" : "block";
  linkBtn.classList.toggle("active", !showing);
  if (!showing) linkInput.focus();
});

taskListEl.addEventListener("input", (e) => {
  if (e.target.dataset.edit) state.editValue = e.target.value;
});

// klik di luar input dianggap simpan, supaya hasil ketikan tidak hilang tanpa sebab
taskListEl.addEventListener("focusout", (e) => {
  if (e.target.dataset.edit && state.editing) {
    state.editValue = e.target.value;
    saveEdit();
  }
});

taskListEl.addEventListener("keydown", (e) => {
  if (e.target.dataset.edit) {
    if (e.key === "Enter") {
      state.editValue = e.target.value;
      saveEdit();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
    return;
  }
  if (e.key === "Enter" && e.target.classList.contains("subtask-input")) {
    const taskId = e.target.dataset.taskId;
    const parentId = e.target.dataset.parentId || "";
    const text = e.target.value;
    const linkInput = taskListEl.querySelector(
      `.subtask-link-input[data-task-id="${taskId}"][data-parent-id="${parentId}"]`
    );
    const link = linkInput ? linkInput.value : "";
    e.target.value = "";
    if (linkInput) linkInput.value = "";
    addSubtask(taskId, parentId, text, link);
  }
});

// ---------- PDF Export ----------
function pdfSafe(str) {
  const clean = String(str || "").replace(/[^\x20-\x7E\xA0-\xFF]/g, "").replace(/\s+/g, " ").trim();
  return clean || "-";
}

const PDF_NAVY = [22, 52, 50];
const PDF_ACCENT = [15, 110, 110];
const PDF_GRAY_BG = [241, 246, 245];
const PDF_GREEN = [22, 121, 79];
const PDF_AMBER = [138, 98, 8];
const PDF_RED = [179, 58, 48];

function taskStatusLabel(t) {
  const pct = taskProgress(t);
  if (t.completed || pct === 100) return "Selesai";
  if (pct > 0) return "Proses";
  return "Belum";
}

function flattenSubtasksForPdf(nodes, depth, rows, meta) {
  (nodes || []).forEach((s) => {
    rows.push([
      "",
      "    ".repeat(depth) + "- " + pdfSafe(s.text),
      "",
      "",
      "",
      s.completed ? "Selesai" : "Belum",
      "",
    ]);
    meta.push("sub");
    flattenSubtasksForPdf(s.children, depth + 1, rows, meta);
  });
}

function pdfTaskTable(pdf, list, startY) {
  const rows = [];
  const meta = [];
  list.forEach((t, i) => {
    const pct = taskProgress(t);
    rows.push([
      String(i + 1),
      pdfSafe(t.text),
      CATEGORY_LABELS[t.category] || "-",
      PRIORITY_LABELS[t.priority] || "-",
      t.deadline ? formatDate(t.deadline) : "-",
      taskStatusLabel(t),
      pct + "%",
    ]);
    meta.push("task");
    flattenSubtasksForPdf(t.subtasks, 0, rows, meta);
  });

  pdf.autoTable({
    startY,
    head: [["No", "Tugas", "Kategori", "Prioritas", "Deadline", "Status", "Progres"]],
    body: rows,
    margin: { left: 14, right: 14, top: 20, bottom: 18 },
    styles: { font: "helvetica", fontSize: 8.5, cellPadding: 2.2, textColor: [45, 50, 60] },
    headStyles: { fillColor: PDF_NAVY, textColor: 255, fontStyle: "bold", fontSize: 8.5 },
    alternateRowStyles: { fillColor: [248, 249, 252] },
    columnStyles: {
      0: { cellWidth: 9, halign: "center" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 20 },
      3: { cellWidth: 19 },
      4: { cellWidth: 25 },
      5: { cellWidth: 18 },
      6: { cellWidth: 17, halign: "right" },
    },
    didParseCell(d) {
      if (d.section !== "body") return;
      const m = meta[d.row.index];
      if (m === "task") {
        if (d.column.index === 1 || d.column.index === 6) d.cell.styles.fontStyle = "bold";
      } else {
        d.cell.styles.textColor = [115, 121, 133];
        d.cell.styles.fontSize = 8;
      }
      if (d.column.index === 5 && d.cell.raw) {
        if (d.cell.raw === "Selesai") d.cell.styles.textColor = PDF_GREEN;
        else if (d.cell.raw === "Proses") d.cell.styles.textColor = PDF_AMBER;
        else if (d.cell.raw === "Belum") d.cell.styles.textColor = PDF_RED;
        d.cell.styles.fontStyle = "bold";
      }
    },
  });
  return pdf.lastAutoTable.finalY;
}

function pdfProgressBar(pdf, x, y, w, pct, color) {
  pdf.setFillColor(228, 231, 238);
  pdf.roundedRect(x, y, w, 5, 2.5, 2.5, "F");
  if (pct > 0) {
    const fw = Math.max((w * pct) / 100, 5);
    pdf.setFillColor(...color);
    pdf.roundedRect(x, y, fw, 5, 2.5, 2.5, "F");
  }
}

function pdfStatBox(pdf, x, y, w, label, value, color) {
  pdf.setFillColor(...PDF_GRAY_BG);
  pdf.roundedRect(x, y, w, 18, 2, 2, "F");
  pdf.setTextColor(...color);
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "bold");
  pdf.text(String(value), x + 5, y + 9);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(7.5);
  pdf.setTextColor(115, 121, 133);
  pdf.text(label, x + 5, y + 14.5);
}

function exportPdf(target) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert("Library PDF belum termuat. Periksa koneksi internet lalu coba lagi.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: "mm", format: "a4" });

  const isAll = target === "all";
  const proj = projects.find((p) => p.id === target);
  const projName = isAll ? "Semua Proyek" : proj ? proj.name : "Tanpa Proyek";
  const scoped = isAll ? tasks : tasks.filter((t) => (t.projectId || "") === target);
  const todayLabel = new Date().toLocaleDateString("id-ID", {
    day: "numeric", month: "long", year: "numeric",
  });

  // Header band
  pdf.setFillColor(...PDF_NAVY);
  pdf.rect(0, 0, 210, 36, "F");
  pdf.setTextColor(180, 190, 215);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(9);
  pdf.text("LAPORAN PROGRES PROYEK", 14, 13);
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(19);
  pdf.text(pdfSafe(projName), 14, 24);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(200, 208, 228);
  pdf.text(todayLabel, 196, 13, { align: "right" });
  pdf.text("TaskFlow", 196, 24, { align: "right" });

  let y = 46;

  // Overall progress
  const overallPct = meanProgress(scoped);
  pdf.setTextColor(60, 66, 80);
  pdf.setFontSize(10);
  pdf.setFont("helvetica", "bold");
  pdf.text("Progres Keseluruhan", 14, y);
  pdf.setFontSize(16);
  pdf.setTextColor(...PDF_ACCENT);
  pdf.text(overallPct + "%", 196, y + 1, { align: "right" });
  y += 4;
  pdfProgressBar(pdf, 14, y, 182, overallPct, PDF_ACCENT);
  y += 13;

  // Stat boxes
  const total = scoped.length;
  const selesai = scoped.filter((t) => taskStatusLabel(t) === "Selesai").length;
  const proses = scoped.filter((t) => taskStatusLabel(t) === "Proses").length;
  const belum = total - selesai - proses;
  const boxW = 42.5;
  pdfStatBox(pdf, 14, y, boxW, "Total Tugas", total, [45, 50, 60]);
  pdfStatBox(pdf, 14 + boxW + 4, y, boxW, "Selesai", selesai, PDF_GREEN);
  pdfStatBox(pdf, 14 + (boxW + 4) * 2, y, boxW, "Dalam Proses", proses, PDF_AMBER);
  pdfStatBox(pdf, 14 + (boxW + 4) * 3, y, boxW, "Belum Mulai", belum, PDF_RED);
  y += 28;

  // Task tables
  if (scoped.length === 0) {
    pdf.setFontSize(10);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(115, 121, 133);
    pdf.text("Belum ada tugas pada proyek ini.", 14, y);
  } else if (isAll) {
    // Group per project (+ tasks without project)
    const groups = projects.map((p) => ({
      name: p.name,
      list: tasks.filter((t) => t.projectId === p.id),
    }));
    const noProj = tasks.filter((t) => !projects.some((p) => p.id === t.projectId));
    if (noProj.length) groups.push({ name: "Tanpa Proyek", list: noProj });

    groups.forEach((g) => {
      if (!g.list.length) return;
      if (y > 240) {
        pdf.addPage();
        y = 22;
      }
      const gPct = meanProgress(g.list);
      pdf.setFillColor(...PDF_ACCENT);
      pdf.rect(14, y - 3.5, 1.6, 5, "F");
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(11.5);
      pdf.setTextColor(45, 50, 60);
      pdf.text(pdfSafe(g.name), 18, y);
      pdf.setFontSize(9);
      pdf.setTextColor(...PDF_ACCENT);
      pdf.text(`${gPct}%`, 196, y, { align: "right" });
      pdf.setFont("helvetica", "normal");
      pdf.setTextColor(115, 121, 133);
      pdf.text(`${g.list.length} tugas`, 190 - pdf.getTextWidth(`${gPct}%`), y, { align: "right" });
      y = pdfTaskTable(pdf, g.list, y + 4) + 10;
    });
  } else {
    y = pdfTaskTable(pdf, scoped, y);
  }

  // Footer on every page
  const pageCount = pdf.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    pdf.setDrawColor(222, 226, 235);
    pdf.setLineWidth(0.2);
    pdf.line(14, 285, 196, 285);
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.5);
    pdf.setTextColor(150, 155, 168);
    pdf.text(`Dibuat dengan TaskFlow — ${todayLabel}`, 14, 290);
    pdf.text(`Halaman ${i} dari ${pageCount}`, 196, 290, { align: "right" });
  }

  const fileName = `Laporan_${projName.replace(/[^\w-]+/g, "_")}_${new Date()
    .toISOString()
    .slice(0, 10)}.pdf`;
  pdf.save(fileName);
}

// ---------- Copy as Text ----------
function flattenSubtasksForText(nodes, depth, lines) {
  (nodes || []).forEach((s) => {
    lines.push("  ".repeat(depth + 1) + (s.completed ? "[x] " : "[ ] ") + s.text);
    flattenSubtasksForText(s.children, depth + 1, lines);
  });
}

function taskLineForText(t) {
  const meta = [
    CATEGORY_LABELS[t.category],
    PRIORITY_LABELS[t.priority] ? `Prioritas ${PRIORITY_LABELS[t.priority]}` : null,
    t.deadline ? `deadline ${formatDate(t.deadline)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `[${t.completed ? "x" : " "}] ${t.text}` + (meta ? ` (${meta})` : "");
}

function appendTaskGroupText(list, lines) {
  const belum = list.filter((t) => !t.completed);
  const selesai = list.filter((t) => t.completed);

  lines.push(`BELUM SELESAI (${belum.length})`);
  if (!belum.length) {
    lines.push("  (tidak ada)");
  } else {
    belum.forEach((t) => {
      lines.push(taskLineForText(t));
      flattenSubtasksForText(t.subtasks, 0, lines);
    });
  }
  lines.push("");
  lines.push(`SELESAI (${selesai.length})`);
  if (!selesai.length) {
    lines.push("  (tidak ada)");
  } else {
    selesai.forEach((t) => {
      lines.push(taskLineForText(t));
      flattenSubtasksForText(t.subtasks, 0, lines);
    });
  }
}

function buildTasksText(target) {
  const isAll = target === "all";
  const proj = projects.find((p) => p.id === target);
  const projName = isAll ? "Semua Proyek" : proj ? proj.name : "Tanpa Proyek";
  const scoped = isAll ? tasks : tasks.filter((t) => (t.projectId || "") === target);
  const todayLabel = new Date().toLocaleDateString("id-ID", {
    day: "numeric", month: "long", year: "numeric",
  });

  const lines = [];
  lines.push(`TaskFlow — Daftar Tugas: ${projName}`);
  lines.push(todayLabel);
  lines.push(`Progres keseluruhan: ${meanProgress(scoped)}%`);
  lines.push("");

  if (!scoped.length) {
    lines.push("Belum ada tugas.");
    return lines.join("\n");
  }

  if (isAll) {
    const groups = projects.map((p) => ({ name: p.name, list: tasks.filter((t) => t.projectId === p.id) }));
    const noProj = tasks.filter((t) => !projects.some((p) => p.id === t.projectId));
    if (noProj.length) groups.push({ name: "Tanpa Proyek", list: noProj });

    let first = true;
    groups.forEach((g) => {
      if (!g.list.length) return;
      if (!first) lines.push("");
      first = false;
      lines.push(`===== ${g.name} (${meanProgress(g.list)}%) =====`);
      appendTaskGroupText(g.list, lines);
    });
  } else {
    appendTaskGroupText(scoped, lines);
  }

  return lines.join("\n");
}

// ---------- Copy for WhatsApp (*tebal*, ~coret~, _miring_) ----------
function waTaskMeta(t) {
  const meta = [
    CATEGORY_LABELS[t.category],
    PRIORITY_LABELS[t.priority],
    t.deadline ? `tenggat ${formatDate(t.deadline)}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  return meta ? ` _(${meta})_` : "";
}

function flattenSubtasksForWa(nodes, depth, lines) {
  (nodes || []).forEach((s) => {
    const bullet = depth === 0 ? "◦" : "-";
    const text = s.completed ? `~${s.text}~` : s.text;
    lines.push("   ".repeat(depth + 1) + `_${bullet} ${text}_`);
    flattenSubtasksForWa(s.children, depth + 1, lines);
  });
}

function appendTaskGroupWa(list, lines) {
  const belum = list.filter((t) => !t.completed);
  const selesai = list.filter((t) => t.completed);

  lines.push(`*BELUM SELESAI (${belum.length})*`);
  if (!belum.length) {
    lines.push("_(tidak ada)_");
  } else {
    belum.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.text}${waTaskMeta(t)}`);
      flattenSubtasksForWa(t.subtasks, 0, lines);
    });
  }
  lines.push("");
  lines.push(`*SELESAI (${selesai.length})*`);
  if (!selesai.length) {
    lines.push("_(tidak ada)_");
  } else {
    selesai.forEach((t, i) => {
      lines.push(`${i + 1}. ~${t.text}~${waTaskMeta(t)}`);
      flattenSubtasksForWa(t.subtasks, 0, lines);
    });
  }
}

function buildWhatsAppText(target) {
  const isAll = target === "all";
  const proj = projects.find((p) => p.id === target);
  const projName = isAll ? "Semua Proyek" : proj ? proj.name : "Tanpa Proyek";
  const scoped = isAll
    ? tasks.filter((t) => !t.archived)
    : tasks.filter((t) => !t.archived && (t.projectId || "") === target);
  const todayLabel = new Date().toLocaleDateString("id-ID", {
    day: "numeric", month: "long", year: "numeric",
  });

  const lines = [];
  lines.push(`*LAPORAN TUGAS — ${projName.toUpperCase()}*`);
  lines.push(`_${todayLabel} • progres ${meanProgress(scoped)}%_`);
  lines.push("");

  if (!scoped.length) {
    lines.push("_Belum ada tugas._");
    return lines.join("\n");
  }

  if (isAll) {
    const groups = projects.map((p) => ({
      name: p.name,
      list: scoped.filter((t) => t.projectId === p.id),
    }));
    const noProj = scoped.filter((t) => !projects.some((p) => p.id === t.projectId));
    if (noProj.length) groups.push({ name: "Tanpa Proyek", list: noProj });

    let first = true;
    groups.forEach((g) => {
      if (!g.list.length) return;
      if (!first) lines.push("");
      first = false;
      lines.push(`*${g.name.toUpperCase()} — ${meanProgress(g.list)}%*`);
      appendTaskGroupWa(g.list, lines);
    });
  } else {
    appendTaskGroupWa(scoped, lines);
  }

  return lines.join("\n");
}

const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function flashCopySuccess(btn) {
  // innerHTML, bukan textContent — kalau tidak, ikon SVG di dalam tombol ikut terhapus
  const original = btn.innerHTML;
  btn.innerHTML = `${CHECK_ICON}<span>Tersalin!</span>`;
  btn.disabled = true;
  setTimeout(() => {
    btn.innerHTML = original;
    btn.disabled = false;
  }, 1500);
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    flashCopySuccess(btn);
    return;
  } catch (err) {
    // Clipboard API unavailable (non-secure context / older browser) — fall back.
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
    flashCopySuccess(btn);
  } catch (e) {
    alert("Gagal menyalin otomatis. Berikut teksnya:\n\n" + text);
  }
  document.body.removeChild(ta);
}

function copyTasksAsText(target) {
  return copyToClipboard(buildTasksText(target), copyTextBtn);
}

function copyTasksAsWhatsApp(target) {
  return copyToClipboard(buildWhatsAppText(target), copyWaBtn);
}

// ---------- Init ----------
onSnapshot(projectsCollection, (snapshot) => {
  projects = snapshot.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  render();
});

onSnapshot(tasksCollection, (snapshot) => {
  tasks = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
  autoArchiveOldTasks();
});

setInterval(autoArchiveOldTasks, 30 * 60 * 1000); // cek arsip tiap 30 menit
