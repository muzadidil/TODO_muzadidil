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

let tasks = [];
let state = {
  navFilter: "all",       // all | today | active | completed
  category: "all",        // all | kerja | pribadi | belajar
  priority: "all",        // all | high | medium | low
  search: "",
  sort: "newest",
  expanded: new Set(),    // task ids with subtasks panel open
};

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function isToday(dateStr) {
  if (!dateStr) return false;
  const today = new Date().toISOString().slice(0, 10);
  return dateStr === today;
}

const CATEGORY_LABELS = { kerja: "Kerja", pribadi: "Pribadi", belajar: "Belajar" };
const PRIORITY_LABELS = { high: "Tinggi", medium: "Sedang", low: "Rendah" };
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

// ---------- DOM refs ----------
const taskListEl = document.getElementById("taskList");
const emptyStateEl = document.getElementById("emptyState");
const taskInput = document.getElementById("taskInput");
const taskCategory = document.getElementById("taskCategory");
const taskPriority = document.getElementById("taskPriority");
const taskDate = document.getElementById("taskDate");
const addTaskBtn = document.getElementById("addTaskBtn");
const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const viewTitle = document.getElementById("viewTitle");
const viewSubtitle = document.getElementById("viewSubtitle");

// ---------- Event bindings ----------
addTaskBtn.addEventListener("click", addTask);
taskInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addTask();
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
    updateViewTitle();
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

function updateViewTitle() {
  const map = {
    all: ["Semua Tugas", "Kelola semua tugasmu di satu tempat"],
    today: ["Hari Ini", "Tugas dengan tenggat waktu hari ini"],
    active: ["Belum Selesai", "Tugas yang masih perlu dikerjakan"],
    completed: ["Selesai", "Tugas yang sudah kamu selesaikan"],
  };
  const [title, subtitle] = map[state.navFilter];
  viewTitle.textContent = title;
  viewSubtitle.textContent = subtitle;
}

// ---------- Core actions ----------
async function addTask() {
  const text = taskInput.value.trim();
  if (!text) return;

  await addDoc(tasksCollection, {
    text,
    category: taskCategory.value,
    priority: taskPriority.value,
    dueDate: taskDate.value || "",
    completed: false,
    subtasks: [],
    createdAt: Date.now(),
  });

  taskInput.value = "";
  taskDate.value = "";
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

async function addSubtask(taskId, text) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t || !text.trim()) return;
  const subtasks = [...(t.subtasks || []), { id: uid(), text: text.trim(), completed: false }];
  await updateDoc(doc(db, "tasks", taskId), { subtasks });
}

async function toggleSubtask(taskId, subId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;
  const subtasks = (t.subtasks || []).map((s) =>
    s.id === subId ? { ...s, completed: !s.completed } : s
  );
  await updateDoc(doc(db, "tasks", taskId), { subtasks });
}

async function deleteSubtask(taskId, subId) {
  const t = tasks.find((t) => t.id === taskId);
  if (!t) return;
  const subtasks = (t.subtasks || []).filter((s) => s.id !== subId);
  await updateDoc(doc(db, "tasks", taskId), { subtasks });
}

// ---------- Filtering / sorting ----------
function getFilteredTasks() {
  let list = [...tasks];

  if (state.navFilter === "today") list = list.filter((t) => isToday(t.dueDate));
  if (state.navFilter === "active") list = list.filter((t) => !t.completed);
  if (state.navFilter === "completed") list = list.filter((t) => t.completed);

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
      list.sort((a, b) => (a.dueDate || "9999").localeCompare(b.dueDate || "9999"));
      break;
    default: // newest
      list.sort((a, b) => b.createdAt - a.createdAt);
  }

  return list;
}

// ---------- Rendering ----------
function render() {
  renderStats();
  renderTasks();
}

function renderStats() {
  const total = tasks.length;
  const done = tasks.filter((t) => t.completed).length;
  const active = total - done;
  const progress = total ? Math.round((done / total) * 100) : 0;

  document.getElementById("statTotal").textContent = total;
  document.getElementById("statActive").textContent = active;
  document.getElementById("statDone").textContent = done;
  document.getElementById("statProgress").textContent = progress + "%";

  document.getElementById("sidebarProgressFill").style.width = progress + "%";
  document.getElementById("sidebarProgressText").textContent = progress + "% selesai";
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
    const subDone = subtasks.filter((s) => s.completed).length;
    const isExpanded = state.expanded.has(t.id);

    const wrap = document.createElement("div");
    wrap.className = "task-wrap";

    const item = document.createElement("div");
    item.className = "task-item" + (t.completed ? " completed" : "");

    item.innerHTML = `
      <button class="task-checkbox ${t.completed ? "checked" : ""}" data-id="${t.id}" data-action="toggle">${t.completed ? "✓" : ""}</button>
      <div class="task-body">
        <div class="task-text"></div>
        <div class="task-meta">
          <span class="task-badge badge-${t.category}">${CATEGORY_LABELS[t.category]}</span>
          <span class="task-badge" style="background:transparent;padding:0;gap:5px;">
            <span class="priority-dot priority-${t.priority}"></span>${PRIORITY_LABELS[t.priority]}
          </span>
          ${t.dueDate ? `<span class="task-date">📅 ${t.dueDate}</span>` : ""}
          ${subtasks.length ? `<span class="task-date">${subDone}/${subtasks.length} sub-tugas</span>` : ""}
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

      const subList = subtasks
        .map(
          (s) => `
        <div class="subtask-item">
          <button class="subtask-checkbox ${s.completed ? "checked" : ""}" data-task-id="${t.id}" data-sub-id="${s.id}" data-action="toggle-sub">${s.completed ? "✓" : ""}</button>
          <span class="subtask-text ${s.completed ? "done" : ""}"></span>
          <button class="task-action-btn delete" data-task-id="${t.id}" data-sub-id="${s.id}" data-action="delete-sub">🗑</button>
        </div>`
        )
        .join("");

      panel.innerHTML = `
        ${subList}
        <div class="subtask-add">
          <input type="text" class="subtask-input" placeholder="Tambah sub-tugas..." data-task-id="${t.id}" />
        </div>
      `;

      panel.querySelectorAll(".subtask-text").forEach((el, i) => {
        el.textContent = subtasks[i].text;
      });

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
});

taskListEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.classList.contains("subtask-input")) {
    const taskId = e.target.dataset.taskId;
    const text = e.target.value;
    e.target.value = "";
    addSubtask(taskId, text);
  }
});

// ---------- Init ----------
onSnapshot(tasksCollection, (snapshot) => {
  tasks = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
  render();
});
