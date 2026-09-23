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
const mastersCollection = collection(db, "masters");

let tasks = [];
let projects = [];
let masters = [];
let mastersError = null;
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
  editing: null,          // { taskId } atau { taskId, subId } yang sedang diedit
  editDraft: {},          // isian form edit, disimpan agar tidak hilang saat re-render
  editingProject: null,   // id proyek yang namanya sedang diubah
  editProjectValue: "",
  descEditing: null,      // "taskId" atau "taskId:subId" yang deskripsinya sedang ditulis
  descDraft: "",
  descExpanded: new Set(), // deskripsi panjang yang sedang dibuka penuh
};

const ICONS = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  restore: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"/><path d="M4 9h11a5 5 0 0 1 0 10h-5"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  note: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>`,
  up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
  down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
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

// ---------- Harga (Rupiah) ----------
function parsePrice(value) {
  const n = Number(String(value ?? "").replace(/\D/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatNumber(n) {
  return n ? Math.round(n).toLocaleString("id-ID") : "";
}

function formatRupiah(n) {
  return "Rp " + Math.round(n || 0).toLocaleString("id-ID");
}

function sumPrices(nodes) {
  return (nodes || []).reduce((sum, n) => sum + nodePrice(n), 0);
}

// Bila rincian di bawahnya diberi harga, harga induk = jumlah rincian (harga induk sendiri diabaikan)
// supaya tidak terhitung dobel.
function nodePrice(n) {
  const fromChildren = sumPrices(n.children);
  return fromChildren > 0 ? fromChildren : Number(n.price) || 0;
}

function taskPrice(t) {
  const fromChildren = sumPrices(t.subtasks);
  return fromChildren > 0 ? fromChildren : Number(t.price) || 0;
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

function patchNodeInTree(nodes, subId, patch) {
  return nodes.map((n) =>
    n.id === subId
      ? { ...n, ...patch }
      : { ...n, children: patchNodeInTree(n.children || [], subId, patch) }
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

// Tugas untuk laporan klien: yang terarsip otomatis karena selesai tetap ikut (tampil dicoret),
// sedangkan yang diarsipkan manual sebelum selesai dianggap batal.
function reportTasks(target) {
  const base = tasks.filter((t) => !t.archived || t.completed);
  return target === "all" ? base : base.filter((t) => (t.projectId || "") === target);
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
const waOptions = document.getElementById("waOptions");
const waIncludePrice = document.getElementById("waIncludePrice");
const waIncludeDesc = document.getElementById("waIncludeDesc");
const masterBtn = document.getElementById("masterBtn");
const masterModalOverlay = document.getElementById("masterModalOverlay");
const masterModalBody = document.getElementById("masterModalBody");
const masterModalClose = document.getElementById("masterModalClose");

let exportMode = "pdf"; // "pdf" | "text" | "wa"

const SORT_STORAGE_KEY = "taskflow_sort";

function setSort(value) {
  state.sort = value;
  sortSelect.value = value;
  try {
    localStorage.setItem(SORT_STORAGE_KEY, value);
  } catch (e) {
    // penyimpanan browser diblokir — urutan cukup berlaku untuk sesi ini
  }
}

try {
  const savedSort = localStorage.getItem(SORT_STORAGE_KEY);
  if (savedSort && [...sortSelect.options].some((o) => o.value === savedSort)) {
    state.sort = savedSort;
    sortSelect.value = savedSort;
  }
} catch (e) {
  // penyimpanan browser diblokir — pakai urutan bawaan
}

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
  setSort(e.target.value);
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
  wa: ["Salin Laporan untuk WhatsApp", "Format resmi untuk klien: judul & tahapan tebal, pekerjaan selesai dicoret, istilah asing miring."],
};

function openExportModal(mode) {
  exportMode = mode;
  const [title, sub] = EXPORT_MODAL_COPY[mode];
  exportModalTitle.textContent = title;
  exportModalSub.textContent = sub;
  waOptions.style.display = mode === "wa" ? "flex" : "none";
  waIncludePrice.checked = false;
  waIncludeDesc.checked = false;
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
  const rename = e.target.closest("[data-rename-project]");
  if (rename) {
    e.stopPropagation();
    startProjectRename(rename.dataset.renameProject);
    return;
  }
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

projectListEl.addEventListener("input", (e) => {
  if (e.target.dataset.editProject) state.editProjectValue = e.target.value;
});

projectListEl.addEventListener("keydown", (e) => {
  if (!e.target.dataset.editProject) return;
  if (e.key === "Enter") {
    state.editProjectValue = e.target.value;
    saveProjectRename();
  } else if (e.key === "Escape") {
    cancelProjectRename();
  }
});

projectListEl.addEventListener("focusout", (e) => {
  if (e.target.dataset.editProject && state.editingProject) {
    state.editProjectValue = e.target.value;
    saveProjectRename();
  }
});

function startProjectRename(id) {
  const p = projects.find((p) => p.id === id);
  if (!p) return;
  state.editingProject = id;
  state.editProjectValue = p.name;
  render();
}

function cancelProjectRename() {
  state.editingProject = null;
  state.editProjectValue = "";
  render();
}

async function saveProjectRename() {
  const id = state.editingProject;
  const name = state.editProjectValue.trim();
  const p = projects.find((p) => p.id === id);

  state.editingProject = null;
  state.editProjectValue = "";

  if (p && name && p.name !== name) {
    await updateDoc(doc(db, "projects", id), { name });
    return;
  }
  render();
}

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

    if (state.editingProject === p.id) {
      // dirender sebagai div, bukan button, agar input tidak bersarang di dalam tombol
      html += `
      <div class="nav-item proj-item editing">
        <span class="cat-dot" style="background:${projColor(i)}"></span>
        <input class="proj-edit-input" type="text" value="${escapeAttr(state.editProjectValue)}" data-edit-project="1" />
      </div>`;
      return;
    }

    html += `
    <button class="nav-item proj-item ${state.project === p.id ? "active" : ""}" data-project="${p.id}">
      <span class="cat-dot" style="background:${projColor(i)}"></span>
      <span class="proj-name" title="${escapeAttr(p.name)}">${escapeHtml(p.name)}</span>
      <span class="proj-pct">${pct}%</span>
      <span class="proj-act" data-rename-project="${p.id}" title="Ubah nama proyek">${ICONS.edit}</span>
      <span class="proj-act proj-del" data-del-project="${p.id}" title="Hapus proyek">${ICONS.trash}</span>
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

  if (state.editingProject) {
    const input = projectListEl.querySelector('[data-edit-project="1"]');
    if (input && document.activeElement !== input) {
      input.focus();
      input.select();
    }
  }
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
    const total = reportTasks(state.project).reduce((sum, t) => sum + taskPrice(t), 0);
    if (total) subtitle += ` • Nilai ${formatRupiah(total)}`;
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

const EDITABLE_FIELDS = ["projectId", "category", "priority", "deadline", "link"];

function startEdit(taskId, subId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;

  if (subId) {
    const node = findNodeInTree(t.subtasks || [], subId);
    if (!node) return;
    state.expanded.add(taskId);
    state.editing = { taskId, subId };
    state.editDraft = { text: node.text, price: formatNumber(Number(node.price) || 0) };
  } else {
    state.editing = { taskId };
    state.editDraft = {
      text: t.text,
      projectId: t.projectId || "",
      category: t.category,
      priority: t.priority,
      deadline: t.deadline || "",
      link: t.link || "",
      price: formatNumber(Number(t.price) || 0),
    };
  }
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
  state.editDraft = {};
  render();
}

async function saveEdit() {
  const edit = state.editing;
  if (!edit) return;
  const draft = state.editDraft;
  const text = (draft.text || "").trim();
  const t = tasks.find((t) => t.id === edit.taskId);

  // dibersihkan lebih dulu supaya blur setelah re-render tidak menyimpan dua kali
  state.editing = null;
  state.editDraft = {};

  if (!t || !text) {
    render();
    return;
  }

  const price = parsePrice(draft.price);

  if (edit.subId) {
    const node = findNodeInTree(t.subtasks || [], edit.subId);
    const subPatch = {};
    if (node && node.text !== text) subPatch.text = text;
    if (node && (Number(node.price) || 0) !== price) subPatch.price = price;
    if (Object.keys(subPatch).length) {
      await updateDoc(doc(db, "tasks", t.id), {
        subtasks: patchNodeInTree(t.subtasks || [], edit.subId, subPatch),
      });
      return;
    }
    render();
    return;
  }

  const patch = {};
  if (t.text !== text) patch.text = text;
  for (const field of EDITABLE_FIELDS) {
    const next = (draft[field] || "").trim();
    if ((t[field] || "") !== next) patch[field] = next;
  }
  if ((Number(t.price) || 0) !== price) patch.price = price;

  if (Object.keys(patch).length) {
    await updateDoc(doc(db, "tasks", t.id), patch);
    return;
  }
  render();
}

async function startDesc(taskId, subId) {
  const key = subId ? `${taskId}:${subId}` : taskId;
  const wasOpen = state.descEditing;
  // Tutup editor yang sedang terbuka dengan menyimpannya, agar tulisan panjang tidak hilang.
  if (wasOpen) await saveDesc();
  if (wasOpen === key) return;

  const t = tasks.find((t) => t.id === taskId);
  const node = t && (subId ? findNodeInTree(t.subtasks || [], subId) : t);
  if (!node) return;
  state.descEditing = key;
  state.descDraft = node.description || "";
  render();
}

function cancelDesc() {
  state.descEditing = null;
  state.descDraft = "";
  render();
}

async function saveDesc() {
  const key = state.descEditing;
  if (!key) return;
  const description = state.descDraft.trim();
  state.descEditing = null;
  state.descDraft = "";

  const [taskId, subId] = key.split(":");
  const t = tasks.find((t) => t.id === taskId);
  if (t && subId) {
    const node = findNodeInTree(t.subtasks || [], subId);
    if (node && (node.description || "") !== description) {
      await updateDoc(doc(db, "tasks", taskId), {
        subtasks: patchNodeInTree(t.subtasks || [], subId, { description }),
      });
      return;
    }
  } else if (t && (t.description || "") !== description) {
    await updateDoc(doc(db, "tasks", taskId), { description });
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
    list = list.filter((t) =>
      `${t.text} ${t.description || ""}`.toLowerCase().includes(state.search)
    );
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

function priceInputHtml(autoPrice, value) {
  if (autoPrice) {
    return `<input type="text" class="price-input" value="${formatNumber(autoPrice)}" title="Otomatis: jumlah harga rincian di bawahnya" disabled />`;
  }
  return `<input type="text" class="price-input" inputmode="numeric" data-edit-field="price" value="${escapeAttr(value || "")}" placeholder="Harga (Rp)" title="Harga (Rp)" />`;
}

function renderDescBlock(key, description, marginLeft) {
  const style = marginLeft ? ` style="margin-left:${marginLeft}px"` : "";
  if (state.descEditing === key) {
    return `
      <div class="desc-editor"${style}>
        <textarea data-desc="1" rows="4" placeholder="Tulis deskripsi / penjelasan pekerjaan...">${escapeHtml(state.descDraft)}</textarea>
        <div class="desc-editor-actions">
          <span class="desc-hint">Ctrl+Enter untuk simpan, Esc untuk batal</span>
          <button type="button" class="edit-cancel-btn" data-action="desc-cancel">Batal</button>
          <button type="button" class="edit-save-btn" data-action="desc-save">${ICONS.check}<span>Simpan</span></button>
        </div>
      </div>`;
  }
  if (!description) return "";
  const long = description.length > 220 || description.split("\n").length > 3;
  if (!long) return `<div class="item-desc"${style}>${escapeHtml(description)}</div>`;
  const expanded = state.descExpanded.has(key);
  return `<div class="item-desc long ${expanded ? "" : "clamped"}"${style} data-action="desc-expand" data-key="${escapeAttr(key)}" title="${expanded ? "Klik untuk meringkas" : "Klik untuk melihat selengkapnya"}">${escapeHtml(description)}</div>`;
}

function renderSubEditForm(s) {
  return `
    <div class="subtask-edit">
      <input class="task-edit-input sub" type="text" value="${escapeAttr(state.editDraft.text || "")}" data-edit="1" placeholder="Teks sub-tugas" />
      ${priceInputHtml(sumPrices(s.children), state.editDraft.price)}
      <button type="button" class="edit-cancel-btn sm" data-action="edit-cancel">Batal</button>
      <button type="button" class="edit-save-btn sm" data-action="edit-save">${ICONS.check}<span>Simpan</span></button>
    </div>`;
}

function renderSubtree(taskId, nodes, depth) {
  let html = "";
  (nodes || []).forEach((s) => {
    const addKey = taskId + ":" + s.id;
    const indent = depth * 22;
    const isEditing =
      state.editing && state.editing.taskId === taskId && state.editing.subId === s.id;
    const price = nodePrice(s);
    html += `
      <div class="subtask-item" style="margin-left:${indent}px">
        <button class="subtask-checkbox ${s.completed ? "checked" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="toggle-sub">${s.completed ? ICONS.check : ""}</button>
        ${isEditing
          ? renderSubEditForm(s)
          : `<span class="subtask-text ${s.completed ? "done" : ""}">${escapeHtml(s.text)}</span>
        ${price ? `<span class="price-badge sub"${sumPrices(s.children) ? ` title="Jumlah dari harga rincian"` : ""}>${formatRupiah(price)}</span>` : ""}
        ${s.link ? `<a class="link-badge" href="${escapeAttr(s.link)}" target="_blank" rel="noopener noreferrer">🔗 Link</a>` : ""}
        <button class="task-action-btn desc ${s.description ? "has" : ""} ${state.descEditing === addKey ? "open" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="desc-sub" title="${s.description ? "Ubah deskripsi" : "Tambah deskripsi"}">${ICONS.note}</button>
        <button class="task-action-btn edit" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="edit-sub" title="Ubah teks & harga">${ICONS.edit}</button>
        <button class="task-action-btn addsub ${state.subAddOpen.has(addKey) ? "open" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="add-sub-toggle" title="Tambah sub-tugas di dalamnya">${ICONS.plus}</button>
        <button class="task-action-btn delete" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="delete-sub" title="Hapus">${ICONS.trash}</button>`}
      </div>`;
    html += renderDescBlock(addKey, s.description, indent + 26);
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

function optionsHtml(items, selected) {
  return items
    .map(
      ([value, label]) =>
        `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`
    )
    .join("");
}

function renderTaskEditForm(t) {
  const d = state.editDraft;
  const projectOptions = [["", "Tanpa Proyek"], ...projects.map((p) => [p.id, p.name])];
  const categoryOptions = Object.entries(CATEGORY_LABELS);
  const priorityOptions = [["high", "Tinggi"], ["medium", "Sedang"], ["low", "Rendah"]];

  return `
    <div class="task-edit">
      <input class="task-edit-input" type="text" value="${escapeAttr(d.text || "")}" data-edit="1" placeholder="Teks tugas" />
      <div class="task-edit-fields">
        <select data-edit-field="projectId" title="Proyek">${optionsHtml(projectOptions, d.projectId || "")}</select>
        <select data-edit-field="category" title="Kategori">${optionsHtml(categoryOptions, d.category)}</select>
        <select data-edit-field="priority" title="Prioritas">${optionsHtml(priorityOptions, d.priority)}</select>
        <input type="date" data-edit-field="deadline" value="${escapeAttr(d.deadline || "")}" title="Deadline" />
        ${priceInputHtml(sumPrices(t.subtasks), d.price)}
        <input type="url" data-edit-field="link" value="${escapeAttr(d.link || "")}" placeholder="https://..." title="Link" />
        <div class="task-edit-actions">
          <button type="button" class="edit-save-btn" data-action="edit-save">${ICONS.check}<span>Simpan</span></button>
          <button type="button" class="edit-cancel-btn" data-action="edit-cancel">Batal</button>
        </div>
      </div>
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
    const price = taskPrice(t);
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
        ${isEditing ? renderTaskEditForm(t) : `<div class="task-text"></div>`}
        ${renderDescBlock(t.id, t.description, 0)}
        <div class="task-meta">
          ${proj && state.project === "all" ? `<span class="task-badge badge-project">📁 ${escapeHtml(proj.name)}</span>` : ""}
          <span class="task-badge badge-${t.category}">${CATEGORY_LABELS[t.category]}</span>
          <span class="task-badge" style="background:transparent;padding:0;gap:5px;">
            <span class="priority-dot priority-${t.priority}"></span>${PRIORITY_LABELS[t.priority]}
          </span>
          ${t.dueDate ? `<span class="task-date">📅 ${formatDateTime(t.createdAt)}</span>` : ""}
          ${subTotal ? `<span class="task-date">${subDone}/${subTotal} sub-tugas</span>` : ""}
          ${price ? `<span class="price-badge"${sumPrices(subtasks) ? ` title="Jumlah dari harga rincian"` : ""}>💰 ${formatRupiah(price)}</span>` : ""}
          ${t.link ? `<a class="link-badge" href="${escapeAttr(t.link)}" target="_blank" rel="noopener noreferrer">🔗 Link</a>` : ""}
          ${t.deadline ? `<span class="deadline-badge deadline-${deadlineStatus(t.deadline)}">⏰ ${formatDate(t.deadline)}</span>` : ""}
        </div>
        <div class="task-progress">
          <div class="task-progress-track"><div class="task-progress-fill ${pct === 100 ? "full" : ""}" style="width:${pct}%"></div></div>
          <span class="task-progress-pct">${pct}%</span>
        </div>
      </div>
      <div class="task-actions">
        <button class="task-action-btn desc ${t.description ? "has" : ""} ${state.descEditing === t.id ? "open" : ""}" data-id="${t.id}" data-action="desc" title="${t.description ? "Ubah deskripsi" : "Tambah deskripsi"}">${ICONS.note}</button>
        <button class="task-action-btn edit" data-id="${t.id}" data-action="edit" title="Ubah tugas & harga">${ICONS.edit}</button>
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

  const focusTarget = state.editing
    ? taskListEl.querySelector('[data-edit="1"]')
    : state.descEditing
      ? taskListEl.querySelector('[data-desc="1"]')
      : null;
  if (focusTarget && document.activeElement !== focusTarget) {
    focusTarget.focus();
    focusTarget.setSelectionRange(focusTarget.value.length, focusTarget.value.length);
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
  if (action === "edit-save") {
    saveEdit();
    return;
  }
  if (action === "edit-cancel") {
    cancelEdit();
    return;
  }
  if (action === "edit-sub") {
    startEdit(btn.dataset.taskId, btn.dataset.subId);
    return;
  }
  if (action === "desc") {
    startDesc(btn.dataset.id, null);
    return;
  }
  if (action === "desc-sub") {
    startDesc(btn.dataset.taskId, btn.dataset.subId);
    return;
  }
  if (action === "desc-save") {
    saveDesc();
    return;
  }
  if (action === "desc-cancel") {
    cancelDesc();
    return;
  }
  if (action === "desc-expand") {
    const key = btn.dataset.key;
    if (state.descExpanded.has(key)) state.descExpanded.delete(key);
    else state.descExpanded.add(key);
    render();
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
  const { edit, editField, desc } = e.target.dataset;
  if (edit) state.editDraft.text = e.target.value;
  else if (editField) state.editDraft[editField] = e.target.value;
  else if (desc) state.descDraft = e.target.value;
});

taskListEl.addEventListener("change", (e) => {
  const field = e.target.dataset.editField;
  if (!field) return;
  if (field === "price") e.target.value = formatNumber(parsePrice(e.target.value));
  state.editDraft[field] = e.target.value;
});

// Form sub-tugas tersimpan saat fokus keluar dari form — tapi tidak saat berpindah
// dari isian teks ke isian harga di dalam form yang sama.
taskListEl.addEventListener("focusout", (e) => {
  if (!state.editing || !state.editing.subId) return;
  const form = e.target.closest(".subtask-edit");
  if (!form || (e.relatedTarget && form.contains(e.relatedTarget))) return;
  saveEdit();
});

// Tombol Simpan/Batal tidak boleh mengambil fokus, supaya focusout di atas tidak
// menyimpan lebih dulu sebelum klik "Batal" sempat diproses (Safari tidak memberi relatedTarget).
taskListEl.addEventListener("mousedown", (e) => {
  if (e.target.closest(".subtask-edit button")) e.preventDefault();
});

taskListEl.addEventListener("keydown", (e) => {
  if (e.target.dataset.desc) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      state.descDraft = e.target.value;
      saveDesc();
    } else if (e.key === "Escape") {
      cancelDesc();
    }
    return;
  }
  if (e.target.dataset.edit || e.target.dataset.editField) {
    if (e.key === "Enter") {
      if (e.target.dataset.edit) state.editDraft.text = e.target.value;
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

// ---------- Copy for WhatsApp (*tebal*, _miring_, ~coret~) ----------
// Hierarki laporan klien: Judul proyek & tahapan (tugas) tebal, rincian (sub) normal,
// rincian di bawahnya miring. Pekerjaan selesai dicoret, istilah asing dimiringkan.

// Istilah asing yang lazim di laporan proyek dan belum diserap ke bahasa Indonesia.
// Kata serapan (data, model, admin, menu, filter, sistem, ...) sengaja tidak dimasukkan.
const FOREIGN_WORDS = new Set(`
  about acceptance access account analytics and animation app apps approval approve article assets at auth authentication authorization
  back backend backup background banner barcode blog booking branch branding brief briefing browser bug bugfix build builder building button by
  cache caption campaign career cart cashier chart chat checkbox checkout cloud code coding comment commit company component config configuration contact content controller cookie copywriting crash cron customer
  dark dashboard database debug debugging default delete delivery deploy deployment design designer desktop developer development device discount domain download draft dropdown
  e-commerce ecommerce email end endpoint environment error event export
  factory feature feed feedback file finishing fix folder follow font footer for form framework friendly front frontend full fullstack
  gallery gateway go
  handling handover hardware header hero home homepage hosting hotfix
  icon image import improvement in install installation integration interface invoice issue
  job key keyword
  landing language launch launching layout library light link listener live load loading log logging login logout
  maintenance marketing marketplace meeting merge middleware migrate migration milestone mobile mockup module monitoring multi
  navbar news notification
  of offline on onboarding online order out
  package page pagination password payment payload performance permission plugin point popup portfolio preview pricing print printer product production profile progress prototype pull push
  query queue
  real realtime register release reminder render rendering report repository repo request requirement reset response responsive restore review revision reward role rollback route router routing
  sale sales scan scanner schedule schema scope script search section security seed seeder server service session setting setup share shipping shop sidebar sign signup slider social software source spec sprint stack staging stock storage store story style styling submit subscription supplier support sync
  table task team template test tester testimonial testing the theme time timeline to toggle token tool tracking training trigger
  up update upgrade upload uptime us user username
  validation view voucher
  webhook website widget wireframe with workflow
`.trim().split(/\s+/));

function isForeignWord(word) {
  const w = word.toLowerCase().replace(/'s$/, "");
  if (FOREIGN_WORDS.has(w)) return true;
  if (w.length <= 3) return false;
  // bentuk jamak & kata kerja: users, deployed, uploading, updated
  if (w.endsWith("s") && FOREIGN_WORDS.has(w.slice(0, -1))) return true;
  if (w.endsWith("ing") && (FOREIGN_WORDS.has(w.slice(0, -3)) || FOREIGN_WORDS.has(w.slice(0, -3) + "e"))) return true;
  if (w.endsWith("ed") && (FOREIGN_WORDS.has(w.slice(0, -2)) || FOREIGN_WORDS.has(w.slice(0, -1)))) return true;
  return false;
}

// Kata yang menempel pada angka, garis bawah, titik, atau garis miring adalah bagian dari
// snake_case, URL, atau email (user_id, toko.com/login) — tidak boleh diberi penanda miring.
function isGluedWord(before, after) {
  return /[0-9_./@:\\]$/.test(before) || /^(?:[0-9_@]|[./:\\]\S)/.test(after);
}

// Kata asing berurutan digabung dalam satu penanda: "_payment gateway_", bukan "_payment_ _gateway_".
function italicizeForeign(text) {
  const parts = text.split(/([A-Za-z]+(?:'[A-Za-z]+)?)/); // indeks ganjil = kata
  const foreignAt = (i) => isForeignWord(parts[i]) && !isGluedWord(parts[i - 1], parts[i + 1]);
  let out = parts[0];
  let k = 1;
  while (k < parts.length) {
    if (!foreignAt(k)) {
      out += parts[k] + parts[k + 1];
      k += 2;
      continue;
    }
    let run = parts[k];
    let j = k + 2;
    while (j < parts.length && /^[ -]+$/.test(parts[j - 1]) && foreignAt(j)) {
      run += parts[j - 1] + parts[j];
      j += 2;
    }
    out += `_${run}_` + parts[j - 1];
    k = j;
  }
  return out;
}

// Penanda miring manual: _kata_ (hanya bila diapit spasi/tanda baca, jadi snake_case aman).
const MANUAL_ITALIC = /(^|[\s(])_([^_\n]+?)_(?=$|[\s.,;:!?)])/g;

function waInline(text, inItalicLine) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  // Baris yang seluruhnya miring tidak boleh berisi penanda miring lagi — WhatsApp akan salah membaca.
  if (inItalicLine) return src.replace(MANUAL_ITALIC, "$1$2");
  let out = "";
  let last = 0;
  for (const m of src.matchAll(MANUAL_ITALIC)) {
    out += italicizeForeign(src.slice(last, m.index) + m[1]) + `_${m[2]}_`;
    last = m.index + m[0].length;
  }
  return out + italicizeForeign(src.slice(last));
}

const WA_RULE = "━━━━━━━━━━━━━━━━━━";
const WA_INDENT = "      ";

function waProgressBar(pct) {
  const filled = Math.round(pct / 10);
  return "▰".repeat(filled) + "▱".repeat(10 - filled);
}

function waStageIcon(status) {
  if (status === "Selesai") return "✅";
  if (status === "Proses") return "🔄";
  return "⏳";
}

function appendWaDescription(description, indent, lines) {
  String(description || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line, i) => lines.push(`${indent}${i === 0 ? "📝 " : "     "}${waInline(line, false)}`));
}

function appendWaNodes(nodes, depth, parentDone, lines, opts) {
  (nodes || []).forEach((n) => {
    const indent = WA_INDENT.repeat(depth + 1);
    const done = parentDone || !!n.completed;
    const italic = depth > 0;
    let text = waInline(n.text, italic);
    if (done) text = `~${text}~`;
    if (italic) text = `_${text}_`;
    const icon = depth === 0 ? (done ? "✔️" : "▫️") : "↳";
    const price = opts.price ? nodePrice(n) : 0;
    lines.push(`${indent}${icon} ${text}${price ? ` · ${formatRupiah(price)}` : ""}`);
    if (opts.desc && n.description) appendWaDescription(n.description, indent + "    ", lines);
    appendWaNodes(n.children, depth + 1, done, lines, opts);
  });
}

function appendWaStage(t, number, lines, opts) {
  const status = taskStatusLabel(t);
  const done = status === "Selesai";
  let title = waInline(t.text, false);
  if (done) title = `~${title}~`;

  const extras = [`${taskProgress(t)}%`];
  if (opts.price && taskPrice(t)) extras.push(formatRupiah(taskPrice(t)));
  if (!done && t.deadline) extras.push(`⏰ ${formatDate(t.deadline)}`);

  lines.push(`${waStageIcon(status)} *${number}. ${title}* — ${extras.join(" · ")}`);
  if (opts.desc && t.description) appendWaDescription(t.description, WA_INDENT, lines);
  appendWaNodes(t.subtasks, 0, done, lines, opts);
}

function appendWaProject(name, list, lines, opts) {
  const ordered = list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const pct = meanProgress(ordered);
  lines.push(`📁 *${waInline(name, false)}*`);
  lines.push(`📊 Progres: *${pct}%*  ${waProgressBar(pct)}`);
  lines.push("");
  ordered.forEach((t, i) => {
    appendWaStage(t, i + 1, lines, opts);
    lines.push("");
  });
  const subtotal = ordered.reduce((sum, t) => sum + taskPrice(t), 0);
  if (opts.price && opts.subtotal && subtotal) {
    lines.push(`💰 Subtotal: *${formatRupiah(subtotal)}*`);
    lines.push("");
  }
}

function buildWhatsAppText(target, opts = {}) {
  const isAll = target === "all";
  const proj = projects.find((p) => p.id === target);
  const projName = isAll ? "Semua Proyek" : proj ? proj.name : "Tanpa Proyek";
  const scoped = reportTasks(target);
  const todayLabel = new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const lines = [];
  lines.push(opts.price ? "📋 *RINCIAN PEKERJAAN & BIAYA PROYEK*" : "📋 *LAPORAN PROGRES PROYEK*");
  lines.push(`📅 ${todayLabel}`);
  lines.push(WA_RULE);
  lines.push("");

  if (!scoped.length) {
    lines.push(`📁 *${waInline(projName, false)}*`);
    lines.push("Belum ada tahapan pekerjaan.");
    return lines.join("\n");
  }

  if (isAll) {
    const groups = projects.map((p) => ({
      name: p.name,
      list: scoped.filter((t) => t.projectId === p.id),
    }));
    const noProj = scoped.filter((t) => !projects.some((p) => p.id === t.projectId));
    if (noProj.length) groups.push({ name: "Tanpa Proyek", list: noProj });

    groups
      .filter((g) => g.list.length)
      .forEach((g, i) => {
        if (i > 0) {
          lines.push(WA_RULE);
          lines.push("");
        }
        appendWaProject(g.name, g.list, lines, { ...opts, subtotal: true });
      });
  } else {
    appendWaProject(projName, scoped, lines, opts);
  }

  const count = (status) => scoped.filter((t) => taskStatusLabel(t) === status).length;
  lines.push(WA_RULE);
  lines.push("📌 *Ringkasan*");
  if (isAll) lines.push(`📊 Progres keseluruhan: *${meanProgress(scoped)}%*`);
  lines.push(`✅ Selesai: ${count("Selesai")} tahap`);
  lines.push(`🔄 Dalam proses: ${count("Proses")} tahap`);
  lines.push(`⏳ Belum dimulai: ${count("Belum")} tahap`);
  if (opts.price) {
    lines.push(`💰 *Total biaya: ${formatRupiah(scoped.reduce((sum, t) => sum + taskPrice(t), 0))}*`);
  }
  lines.push("");
  lines.push("Terima kasih 🙏");

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
  const opts = { price: waIncludePrice.checked, desc: waIncludeDesc.checked };
  return copyToClipboard(buildWhatsAppText(target, opts), copyWaBtn);
}

// ---------- Master Proyek (template tahapan + rincian + harga) ----------
// Master: { name, stages: [node], createdAt, updatedAt }, node: { id, text, price, description, children }.
// Saat dipakai, setiap tahapan menjadi satu tugas dan rinciannya menjadi sub-tugas.
const MASTER_RULES_HINT =
  'Koleksi "masters" belum diizinkan di Firestore Rules.\n\n' +
  "Buka Firebase Console → Firestore Database → Rules, tambahkan:\n\n" +
  "match /masters/{masterId} {\n  allow read, write: if true;\n}\n\n" +
  "Klik Publish, lalu muat ulang halaman ini.";

let masterUi = { view: "list", draft: null, dirty: false, applyId: null, openDesc: new Set() };

function newMasterNode() {
  return { id: uid(), text: "", price: 0, description: "", children: [] };
}

// Salinan mendalam yang juga merapikan field yang hilang; freshIds untuk salinan baru.
function copyMasterNodes(nodes, freshIds) {
  return (nodes || []).map((n) => ({
    id: freshIds || !n.id ? uid() : n.id,
    text: n.text || "",
    price: Number(n.price) || 0,
    description: n.description || "",
    children: copyMasterNodes(n.children, freshIds),
  }));
}

function masterNodesToSubtasks(nodes) {
  return (nodes || []).map((n) => ({
    id: uid(),
    text: n.text,
    link: "",
    completed: false,
    price: Number(n.price) || 0,
    description: n.description || "",
    children: masterNodesToSubtasks(n.children),
  }));
}

function countNodes(nodes) {
  return (nodes || []).reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

function locateNode(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { list, index: i, node: list[i] };
    const found = locateNode(list[i].children || [], id);
    if (found) return found;
  }
  return null;
}

function reportMasterError(err) {
  if (err && err.code === "permission-denied") alert(MASTER_RULES_HINT);
  else alert("Gagal memproses master: " + (err && err.message ? err.message : err));
}

function openMasterModal() {
  masterUi = { view: "list", draft: null, dirty: false, applyId: null, openDesc: new Set() };
  renderMasterModal();
  masterModalOverlay.classList.add("show");
}

function closeMasterModal() {
  if (masterUi.view === "edit" && masterUi.dirty && !confirm("Perubahan master belum disimpan. Tutup tanpa menyimpan?")) return;
  masterModalOverlay.classList.remove("show");
}

function openMasterEditor(draft, dirty) {
  masterUi = { ...masterUi, view: "edit", draft, dirty, openDesc: new Set() };
  renderMasterModal();
  const nameInput = masterModalBody.querySelector("[data-m-name]");
  if (nameInput) {
    nameInput.focus();
    nameInput.select();
  }
}

function renderMasterModal() {
  if (masterUi.view === "apply" && !masters.some((m) => m.id === masterUi.applyId)) masterUi.view = "list";
  masterModalBody.innerHTML =
    masterUi.view === "edit" ? masterEditHtml() : masterUi.view === "apply" ? masterApplyHtml() : masterListHtml();
}

function masterListHtml() {
  const activeProject = projects.find((p) => p.id === state.project);
  const cards = masters
    .map((m) => {
      const stages = m.stages || [];
      const total = sumPrices(stages);
      const meta = [`${stages.length} tahapan`, `${countNodes(stages) - stages.length} rincian`];
      if (total) meta.push(formatRupiah(total));
      return `
        <div class="master-card">
          <div class="master-card-main">
            <div class="master-card-name">${escapeHtml(m.name || "(tanpa nama)")}</div>
            <div class="master-card-meta">${meta.join(" · ")}</div>
          </div>
          <button type="button" class="master-use-btn" data-m="use" data-id="${m.id}">Gunakan</button>
          <button type="button" class="task-action-btn edit" data-m="edit" data-id="${m.id}" title="Ubah master">${ICONS.edit}</button>
          <button type="button" class="task-action-btn delete" data-m="delete" data-id="${m.id}" title="Hapus master">${ICONS.trash}</button>
        </div>`;
    })
    .join("");

  return `
    <h3>Master Proyek</h3>
    <p class="modal-sub">Template tahapan pekerjaan beserta harga. Pakai ulang untuk setiap proyek baru, lalu bagikan progres & rincian biayanya ke klien.</p>
    ${mastersError ? `
    <div class="master-alert">
      <strong>Master belum bisa dibaca/disimpan.</strong> Koleksi <code>masters</code> belum diizinkan di Firestore Rules.
      Buka Firebase Console → Firestore Database → Rules, tambahkan blok berikut, klik Publish, lalu muat ulang halaman:
      <pre>match /masters/{masterId} {
  allow read, write: if true;
}</pre>
    </div>` : ""}
    <div class="master-toolbar">
      <button type="button" class="master-primary-btn" data-m="new">${ICONS.plus}<span>Master Baru</span></button>
      <button type="button" class="master-secondary-btn" data-m="from-project" ${activeProject ? "" : "disabled"}
        title="${activeProject ? "Salin tahapan, rincian, harga & deskripsi proyek ini menjadi master" : "Pilih satu proyek di sidebar terlebih dahulu"}">
        Jadikan master dari proyek${activeProject ? `: ${escapeHtml(activeProject.name)}` : " aktif"}
      </button>
    </div>
    <div class="master-list">
      ${cards || `<div class="master-empty">Belum ada master. Contoh: buat master <strong>Laravel 12</strong> dengan tahapan MVC, <em>Building</em>, Migrasi, <em>Testing</em>, <em>Deploy</em>, dan <em>Domain</em>, lalu isi rincian & harganya.</div>`}
    </div>`;
}

function masterRowsHtml(nodes, depth, prefix) {
  return nodes
    .map((n, i) => {
      const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      const auto = sumPrices(n.children);
      const descOpen = masterUi.openDesc.has(n.id);
      return `
        <div class="mrow ${depth === 0 ? "stage" : ""}" style="--depth:${depth}">
          <span class="mrow-num">${num}</span>
          <input type="text" class="mrow-text" data-node="${n.id}" data-f="text" value="${escapeAttr(n.text)}" placeholder="${depth === 0 ? "Nama tahapan, mis. MVC" : "Rincian pekerjaan"}" />
          <input type="text" class="mrow-price" inputmode="numeric" data-node="${n.id}" data-f="price" value="${formatNumber(auto || Number(n.price) || 0)}" placeholder="0" ${auto ? `disabled title="Otomatis: jumlah harga rincian"` : ""} />
          <div class="mrow-actions">
            <button type="button" class="task-action-btn desc ${n.description ? "has" : ""} ${descOpen ? "open" : ""}" data-m="node-desc" data-node="${n.id}" title="Deskripsi">${ICONS.note}</button>
            <button type="button" class="task-action-btn addsub" data-m="node-add" data-node="${n.id}" title="Tambah rincian di dalamnya">${ICONS.plus}</button>
            <button type="button" class="task-action-btn" data-m="node-up" data-node="${n.id}" title="Naikkan" ${i === 0 ? "disabled" : ""}>${ICONS.up}</button>
            <button type="button" class="task-action-btn" data-m="node-down" data-node="${n.id}" title="Turunkan" ${i === nodes.length - 1 ? "disabled" : ""}>${ICONS.down}</button>
            <button type="button" class="task-action-btn delete" data-m="node-del" data-node="${n.id}" title="Hapus">${ICONS.trash}</button>
          </div>
        </div>
        ${descOpen ? `<textarea class="mrow-desc" style="--depth:${depth}" data-node="${n.id}" data-f="description" rows="3" placeholder="Deskripsi / penjelasan pekerjaan...">${escapeHtml(n.description || "")}</textarea>` : ""}
        ${masterRowsHtml(n.children || [], depth + 1, num)}`;
    })
    .join("");
}

function masterEditHtml() {
  const d = masterUi.draft;
  return `
    <h3>${d.id ? "Ubah Master" : "Master Baru"}</h3>
    <p class="modal-sub">Tahapan (nomor 1, 2, 3) menjadi tugas, rincian di dalamnya menjadi sub-tugas. Tekan Enter untuk menambah baris berikutnya. Jika rincian diberi harga, harga tahapan otomatis menjadi jumlahnya.</p>
    <input type="text" class="master-name-input" data-m-name="1" value="${escapeAttr(d.name)}" placeholder="Nama master, mis. Laravel 12" />
    <div class="master-tree-head"><span></span><span>Tahapan & rincian</span><span>Harga (Rp)</span><span></span></div>
    <div class="master-tree">${masterRowsHtml(d.stages, 0, "")}</div>
    <button type="button" class="master-add-root" data-m="add-root">${ICONS.plus}<span>Tambah Tahapan</span></button>
    <div class="master-footer">
      <div class="master-total">Total: <strong id="masterTotal">${formatRupiah(sumPrices(d.stages))}</strong></div>
      <button type="button" class="edit-cancel-btn" data-m="back">Batal</button>
      <button type="button" class="edit-save-btn" data-m="save">${ICONS.check}<span>Simpan Master</span></button>
    </div>`;
}

function masterApplyHtml() {
  const m = masters.find((m) => m.id === masterUi.applyId);
  const stages = m.stages || [];
  const total = sumPrices(stages);
  const current = projects.some((p) => p.id === state.project) ? state.project : "__new";
  return `
    <h3>Gunakan Master “${escapeHtml(m.name)}”</h3>
    <p class="modal-sub">${stages.length} tahapan dan ${countNodes(stages) - stages.length} rincian akan ditambahkan sebagai tugas${total ? `, total ${formatRupiah(total)}` : ""}.</p>
    <ol class="master-preview">
      ${stages.map((s) => `<li><span>${escapeHtml(s.text)}</span>${nodePrice(s) ? `<span class="master-preview-price">${formatRupiah(nodePrice(s))}</span>` : ""}</li>`).join("")}
    </ol>
    <label class="master-label" for="masterApplyTarget">Terapkan ke proyek</label>
    <select id="masterApplyTarget" class="master-select">
      <option value="__new" ${current === "__new" ? "selected" : ""}>+ Proyek baru…</option>
      ${projects.map((p) => `<option value="${p.id}" ${p.id === current ? "selected" : ""}>${escapeHtml(p.name)}</option>`).join("")}
    </select>
    <input type="text" id="masterApplyName" class="master-name-input" placeholder="Nama proyek baru, mis. Toko Budi" ${current === "__new" ? "" : `style="display:none;"`} />
    <div class="master-footer">
      <button type="button" class="edit-cancel-btn" data-m="back">Kembali</button>
      <button type="button" class="edit-save-btn" data-m="apply-confirm">${ICONS.check}<span>Terapkan</span></button>
    </div>`;
}

function focusMasterNode(id, selector = ".mrow-text") {
  const el = masterModalBody.querySelector(`${selector}[data-node="${id}"]`);
  if (el) el.focus();
}

// Perbarui harga induk (otomatis) & total di tempat, tanpa render ulang yang akan membuang fokus ketikan.
function syncMasterPrices() {
  const walk = (nodes) =>
    nodes.forEach((n) => {
      const el = masterModalBody.querySelector(`.mrow-price[data-node="${n.id}"]`);
      const auto = sumPrices(n.children);
      if (el && el !== document.activeElement) {
        el.disabled = auto > 0;
        el.title = auto > 0 ? "Otomatis: jumlah harga rincian" : "";
        el.value = formatNumber(auto || Number(n.price) || 0);
      }
      walk(n.children || []);
    });
  walk(masterUi.draft.stages);
  const totalEl = masterModalBody.querySelector("#masterTotal");
  if (totalEl) totalEl.textContent = formatRupiah(sumPrices(masterUi.draft.stages));
}

function addMasterSibling(nodeId) {
  const loc = locateNode(masterUi.draft.stages, nodeId);
  if (!loc) return;
  const node = newMasterNode();
  loc.list.splice(loc.index + 1, 0, node);
  masterUi.dirty = true;
  renderMasterModal();
  focusMasterNode(node.id);
}

function pruneMasterNodes(nodes) {
  return nodes
    .map((n) => ({
      ...n,
      text: n.text.trim(),
      description: (n.description || "").trim(),
      children: pruneMasterNodes(n.children || []),
    }))
    .filter((n) => n.text || n.children.length);
}

function hasUnnamedNode(nodes) {
  return nodes.some((n) => !n.text || hasUnnamedNode(n.children));
}

async function saveMaster(btn) {
  const d = masterUi.draft;
  const name = d.name.trim();
  if (!name) {
    alert('Beri nama master terlebih dahulu, misalnya "Laravel 12".');
    masterModalBody.querySelector("[data-m-name]").focus();
    return;
  }
  const stages = pruneMasterNodes(d.stages);
  if (!stages.length) {
    alert("Tambahkan minimal satu tahapan.");
    return;
  }
  if (hasUnnamedNode(stages)) {
    alert("Ada baris tanpa nama yang masih memiliki rincian. Lengkapi dulu namanya.");
    return;
  }

  btn.disabled = true;
  try {
    const now = Date.now();
    if (d.id) await updateDoc(doc(db, "masters", d.id), { name, stages, updatedAt: now });
    else await addDoc(mastersCollection, { name, stages, createdAt: now, updatedAt: now });
    masterUi = { ...masterUi, view: "list", draft: null, dirty: false };
    renderMasterModal();
  } catch (err) {
    btn.disabled = false;
    reportMasterError(err);
  }
}

function resetNavFilter() {
  state.navFilter = "all";
  document.querySelectorAll(".nav-item[data-filter]").forEach((b) =>
    b.classList.toggle("active", b.dataset.filter === "all")
  );
}

async function applyMaster(btn) {
  const m = masters.find((m) => m.id === masterUi.applyId);
  if (!m) return;
  const target = masterModalBody.querySelector("#masterApplyTarget").value;
  const nameInput = masterModalBody.querySelector("#masterApplyName");
  const newName = nameInput.value.trim();
  if (target === "__new" && !newName) {
    alert("Isi nama proyek baru terlebih dahulu.");
    nameInput.focus();
    return;
  }

  btn.disabled = true;
  try {
    const projectId =
      target === "__new"
        ? (await addDoc(projectsCollection, { name: newName, createdAt: Date.now() })).id
        : target;
    const base = Date.now();
    const today = new Date(base).toISOString().slice(0, 10);
    await Promise.all(
      (m.stages || []).map((s, i) =>
        addDoc(tasksCollection, {
          text: s.text,
          description: s.description || "",
          price: Number(s.price) || 0,
          projectId,
          category: "kerja",
          priority: "medium",
          dueDate: today,
          link: "",
          deadline: "",
          completed: false,
          completedAt: null,
          archived: false,
          subtasks: masterNodesToSubtasks(s.children),
          createdAt: base + i,
        })
      )
    );
    masterModalOverlay.classList.remove("show");
    state.project = projectId;
    resetNavFilter();
    // Tahapan harus tampil berurutan (1, 2, 3...), bukan terbaru di atas.
    setSort("oldest");
    render();
  } catch (err) {
    btn.disabled = false;
    alert("Gagal menerapkan master. Periksa koneksi lalu coba lagi.");
  }
}

async function handleMasterAction(action, btn) {
  const { id, node: nodeId } = btn.dataset;
  const d = masterUi.draft;

  if (action === "new") {
    openMasterEditor({ name: "", stages: [newMasterNode()] }, false);
  } else if (action === "edit") {
    const m = masters.find((m) => m.id === id);
    if (m) openMasterEditor({ id: m.id, name: m.name || "", stages: copyMasterNodes(m.stages, false) }, false);
  } else if (action === "from-project") {
    const p = projects.find((p) => p.id === state.project);
    if (!p) return;
    const stages = reportTasks(p.id)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((t) => ({
        id: uid(),
        text: t.text,
        price: Number(t.price) || 0,
        description: t.description || "",
        children: copyMasterNodes(t.subtasks, true),
      }));
    openMasterEditor({ name: p.name, stages: stages.length ? stages : [newMasterNode()] }, true);
  } else if (action === "delete") {
    const m = masters.find((m) => m.id === id);
    if (!m || !confirm(`Hapus master "${m.name}"? Proyek yang sudah memakai master ini tidak terpengaruh.`)) return;
    try {
      await deleteDoc(doc(db, "masters", id));
    } catch (err) {
      reportMasterError(err);
    }
  } else if (action === "use") {
    masterUi = { ...masterUi, view: "apply", applyId: id };
    renderMasterModal();
    const nameInput = masterModalBody.querySelector("#masterApplyName");
    if (nameInput && nameInput.style.display !== "none") nameInput.focus();
  } else if (action === "back") {
    if (masterUi.view === "edit" && masterUi.dirty && !confirm("Buang perubahan master yang belum disimpan?")) return;
    masterUi = { ...masterUi, view: "list", draft: null, dirty: false };
    renderMasterModal();
  } else if (action === "save") {
    await saveMaster(btn);
  } else if (action === "apply-confirm") {
    await applyMaster(btn);
  } else if (action === "add-root") {
    const node = newMasterNode();
    d.stages.push(node);
    masterUi.dirty = true;
    renderMasterModal();
    focusMasterNode(node.id);
  } else {
    const loc = locateNode(d.stages, nodeId);
    if (!loc) return;
    const { list, index, node } = loc;
    if (action === "node-add") {
      const child = newMasterNode();
      node.children.push(child);
      masterUi.dirty = true;
      renderMasterModal();
      focusMasterNode(child.id);
      return;
    }
    if (action === "node-desc") {
      const open = !masterUi.openDesc.has(node.id);
      if (open) masterUi.openDesc.add(node.id);
      else masterUi.openDesc.delete(node.id);
      renderMasterModal();
      if (open) focusMasterNode(node.id, ".mrow-desc");
      return;
    }
    if (action === "node-del") {
      const nested = countNodes(node.children);
      if (nested && !confirm(`Hapus "${node.text || "baris ini"}" beserta ${nested} rinciannya?`)) return;
      list.splice(index, 1);
      if (!d.stages.length) d.stages.push(newMasterNode());
    } else if (action === "node-up" && index > 0) {
      [list[index - 1], list[index]] = [list[index], list[index - 1]];
    } else if (action === "node-down" && index < list.length - 1) {
      [list[index + 1], list[index]] = [list[index], list[index + 1]];
    }
    masterUi.dirty = true;
    renderMasterModal();
  }
}

masterBtn.addEventListener("click", openMasterModal);
masterModalClose.addEventListener("click", closeMasterModal);
masterModalOverlay.addEventListener("click", (e) => {
  if (e.target === masterModalOverlay) closeMasterModal();
});

masterModalBody.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-m]");
  if (btn && !btn.disabled) handleMasterAction(btn.dataset.m, btn);
});

masterModalBody.addEventListener("input", (e) => {
  const el = e.target;
  if (!masterUi.draft) return;
  if (el.dataset.mName) {
    masterUi.draft.name = el.value;
    masterUi.dirty = true;
    return;
  }
  const field = el.dataset.f;
  const loc = field && locateNode(masterUi.draft.stages, el.dataset.node);
  if (!loc) return;
  loc.node[field] = field === "price" ? parsePrice(el.value) : el.value;
  masterUi.dirty = true;
  if (field === "price") syncMasterPrices();
});

masterModalBody.addEventListener("change", (e) => {
  if (e.target.dataset.f === "price") e.target.value = formatNumber(parsePrice(e.target.value));
  if (e.target.id === "masterApplyTarget") {
    const nameInput = masterModalBody.querySelector("#masterApplyName");
    nameInput.style.display = e.target.value === "__new" ? "" : "none";
    if (e.target.value === "__new") nameInput.focus();
  }
});

masterModalBody.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.dataset.f === "text") {
    e.preventDefault();
    addMasterSibling(e.target.dataset.node);
  } else if (e.target.id === "masterApplyName") {
    e.preventDefault();
    masterModalBody.querySelector('[data-m="apply-confirm"]').click();
  }
});

// ---------- Init ----------
onSnapshot(
  mastersCollection,
  (snapshot) => {
    masters = snapshot.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || "").localeCompare(b.name || "", "id"));
    mastersError = null;
    if (masterModalOverlay.classList.contains("show") && masterUi.view === "list") renderMasterModal();
  },
  (err) => {
    mastersError = err;
    if (masterModalOverlay.classList.contains("show") && masterUi.view === "list") renderMasterModal();
  }
);

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
