const STORAGE_KEY = "taskflow_tasks";

let tasks = loadTasks();
let state = {
  navFilter: "all",       // all | today | active | completed
  category: "all",        // all | kerja | pribadi | belajar
  priority: "all",        // all | high | medium | low
  search: "",
  sort: "newest",
};

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTasks() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

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
function addTask() {
  const text = taskInput.value.trim();
  if (!text) return;

  tasks.unshift({
    id: uid(),
    text,
    category: taskCategory.value,
    priority: taskPriority.value,
    dueDate: taskDate.value || "",
    completed: false,
    createdAt: Date.now(),
  });

  taskInput.value = "";
  taskDate.value = "";
  saveTasks();
  render();
}

function toggleTask(id) {
  const t = tasks.find((t) => t.id === id);
  if (t) t.completed = !t.completed;
  saveTasks();
  render();
}

function deleteTask(id) {
  tasks = tasks.filter((t) => t.id !== id);
  saveTasks();
  render();
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
        </div>
      </div>
      <div class="task-actions">
        <button class="task-action-btn delete" data-id="${t.id}" data-action="delete">🗑</button>
      </div>
    `;

    item.querySelector(".task-text").textContent = t.text;
    taskListEl.appendChild(item);
  });
}

taskListEl.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === "toggle") toggleTask(id);
  if (btn.dataset.action === "delete") deleteTask(id);
});

// ---------- Init ----------
render();
