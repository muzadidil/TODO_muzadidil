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

const CATEGORY_LABELS = { kerja: "Kerja", pribadi: "Pribadi", belajar: "Belajar" };
const PRIORITY_LABELS = { high: "Tinggi", medium: "Sedang", low: "Rendah" };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PROJECT_COLORS = ["#8da2fb", "#5fd39a", "#f0c04c", "#f08484", "#b8a7f0", "#64b5f6", "#4dd0e1", "#ffb74d"];

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

function projectScopedTasks() {
  if (state.project === "all") return tasks;
  return tasks.filter((t) => (t.projectId || "") === state.project);
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
const exportModalOverlay = document.getElementById("exportModalOverlay");
const exportModalTitle = document.getElementById("exportModalTitle");
const exportModalSub = document.getElementById("exportModalSub");
const exportModalClose = document.getElementById("exportModalClose");
const exportAllOption = document.getElementById("exportAllOption");
const exportOneOption = document.getElementById("exportOneOption");
const exportProjectPicker = document.getElementById("exportProjectPicker");
const exportProjectSelect = document.getElementById("exportProjectSelect");
const exportProjectConfirmBtn = document.getElementById("exportProjectConfirmBtn");

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

exportPdfBtn.addEventListener("click", () => openExportModal("pdf"));
copyTextBtn.addEventListener("click", () => openExportModal("text"));

function openExportModal(mode) {
  exportMode = mode;
  exportModalTitle.textContent = mode === "text" ? "Salin Daftar Tugas sebagai Teks" : "Export Laporan PDF";
  exportModalSub.textContent = mode === "text"
    ? "Pilih cakupan tugas yang ingin disalin sebagai teks."
    : "Pilih cakupan laporan yang ingin diexport.";
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
  if (exportMode === "text") copyTasksAsText("all");
  else exportPdf("all");
});

exportOneOption.addEventListener("click", () => {
  if (!projects.length) {
    alert("Belum ada proyek untuk diexport. Buat proyek terlebih dahulu.");
    return;
  }
  exportProjectConfirmBtn.textContent = exportMode === "text" ? "Salin" : "Export";
  exportProjectPicker.style.display = "flex";
});

exportProjectConfirmBtn.addEventListener("click", () => {
  const target = exportProjectSelect.value;
  closeExportModal();
  if (exportMode === "text") copyTasksAsText(target);
  else exportPdf(target);
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
  const counts = {};
  tasks.forEach((t) => {
    const pid = t.projectId || "";
    counts[pid] = (counts[pid] || 0) + 1;
  });

  let html = `
    <button class="nav-item proj-item ${state.project === "all" ? "active" : ""}" data-project="all">
      <span class="nav-icon">▤</span>
      <span class="proj-name">Semua Proyek</span>
      <span class="proj-count">${tasks.length}</span>
    </button>`;

  projects.forEach((p, i) => {
    const scoped = tasks.filter((t) => t.projectId === p.id);
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
  await updateDoc(doc(db, "tasks", id), { completed: !t.completed });
}

async function deleteTask(id) {
  await deleteDoc(doc(db, "tasks", id));
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
  let list = projectScopedTasks().slice();

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
  renderProjects();
  populateTaskProjectSelect();
  updateViewTitle();
  renderStats();
  renderTasks();
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
    html += `
      <div class="subtask-item" style="margin-left:${depth * 22}px">
        <button class="subtask-checkbox ${s.completed ? "checked" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="toggle-sub">${s.completed ? "✓" : ""}</button>
        <span class="subtask-text ${s.completed ? "done" : ""}">${escapeHtml(s.text)}</span>
        ${s.link ? `<a class="link-badge" href="${escapeAttr(s.link)}" target="_blank" rel="noopener noreferrer">🔗 Link</a>` : ""}
        <button class="task-action-btn addsub ${state.subAddOpen.has(addKey) ? "open" : ""}" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="add-sub-toggle" title="Tambah sub-tugas di dalamnya">+</button>
        <button class="task-action-btn delete" data-task-id="${taskId}" data-sub-id="${s.id}" data-action="delete-sub">🗑</button>
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

    const item = document.createElement("div");
    item.className = "task-item" + (t.completed ? " completed" : "");

    item.innerHTML = `
      <button class="task-checkbox ${t.completed ? "checked" : ""}" data-id="${t.id}" data-action="toggle">${t.completed ? "✓" : ""}</button>
      <div class="task-body">
        <div class="task-text"></div>
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
        <button class="task-action-btn expand ${isExpanded ? "open" : ""}" data-id="${t.id}" data-action="expand">▾</button>
        <button class="task-action-btn delete" data-id="${t.id}" data-action="delete">🗑</button>
      </div>
    `;

    item.querySelector(".task-text").textContent = t.text;
    wrap.appendChild(item);

    if (isExpanded) {
      const panel = document.createElement("div");
      panel.className = "subtask-panel";
      panel.innerHTML = renderSubtree(t.id, subtasks, 0) + renderSubAddRow(t.id, "", 0);
      wrap.appendChild(panel);
    }

    taskListEl.appendChild(wrap);
  });
}

taskListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "toggle") toggleTask(btn.dataset.id);
  if (action === "delete") deleteTask(btn.dataset.id);
  if (action === "expand") toggleExpand(btn.dataset.id);
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

taskListEl.addEventListener("keydown", (e) => {
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

const PDF_NAVY = [43, 52, 80];
const PDF_ACCENT = [79, 101, 197];
const PDF_GRAY_BG = [243, 245, 249];
const PDF_GREEN = [34, 139, 84];
const PDF_AMBER = [190, 130, 10];
const PDF_RED = [178, 76, 76];

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

function flashCopySuccess() {
  const original = copyTextBtn.textContent;
  copyTextBtn.textContent = "✅ Tersalin!";
  copyTextBtn.disabled = true;
  setTimeout(() => {
    copyTextBtn.textContent = original;
    copyTextBtn.disabled = false;
  }, 1500);
}

async function copyTasksAsText(target) {
  const text = buildTasksText(target);
  try {
    await navigator.clipboard.writeText(text);
    flashCopySuccess();
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
    flashCopySuccess();
  } catch (e) {
    alert("Gagal menyalin otomatis. Berikut teksnya:\n\n" + text);
  }
  document.body.removeChild(ta);
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
});
