const LEGACY_STORAGE_KEY = "morning-kakao-priority-tasks-v1";
const SESSION = window.__KAKAO_SESSION__;

if (!SESSION?.userId) {
  window.location.replace("/login.html?error=session_required");
  throw new Error("Authenticated Kakao session is required");
}

const SESSION_USER_ID = String(SESSION.userId);
const STORAGE_KEY = `${LEGACY_STORAGE_KEY}:user:${SESSION_USER_ID}`;
const LEGACY_OWNER_KEY = `${LEGACY_STORAGE_KEY}:legacy-owner`;
const DEFAULT_PRIORITY = "medium";
const DELIVERY_HOUR = 8;
const DELIVERY_MINUTE = 30;
const TEXT_TYPE_SPEED = 75;

const PRIORITY_CONFIG = {
  high: {
    label: "높음",
    weight: 3,
    pillClass: "high",
  },
  medium: {
    label: "보통",
    weight: 2,
    pillClass: "medium",
  },
  low: {
    label: "낮음",
    weight: 1,
    pillClass: "low",
  },
};

migrateLegacyTasks();

const state = {
  selectedPriority: DEFAULT_PRIORITY,
  tasks: loadTasks(),
};
const animatedTaskIds = new Set();

const form = document.querySelector("#todo-form");
const input = document.querySelector("#todo-input");
const feedback = document.querySelector("#form-feedback");
const chips = Array.from(document.querySelectorAll(".priority-chip"));
const logoutForm = document.querySelector(".logout-form");
const taskList = document.querySelector("#task-list");
const emptyState = document.querySelector("#empty-state");
const taskSummary = document.querySelector("#task-summary");
const briefingList = document.querySelector("#briefing-list");
const nextDeliveryLabel = document.querySelector("#next-delivery-label");
const SHUFFLE_CHARSET = "가나다라마바사아자차카타파하ABCDEFGHJKLMNPQRSTUVWXYZ123456789";
const sessionUserName = document.querySelector("#session-user-name");

sessionUserName.textContent = resolveSessionDisplayName(SESSION);

initializeShuffleText();
initializeTodoInputTextType();

chips.forEach((chip) => {
  chip.addEventListener("click", () => {
    setSelectedPriority(chip.dataset.priority);
  });
});

taskList.addEventListener("click", (event) => {
  const completeButton = event.target.closest(".complete-button");
  if (completeButton) {
    completeTask(completeButton.dataset.taskId);
    return;
  }

  const button = event.target.closest(".snooze-button");
  if (!button) {
    return;
  }

  snoozeTask(button.dataset.taskId);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const rawText = input.value.trim();
  if (!rawText) {
    feedback.textContent = "할 일을 한 줄만 적어주세요.";
    input.focus();
    return;
  }

  const task = {
    id: createTaskId(),
    text: normalizeWhitespace(rawText),
    priority: state.selectedPriority,
    createdAt: new Date().toISOString(),
  };

  state.tasks.push(task);
  saveTasks(state.tasks);
  render();

  form.reset();
  setSelectedPriority(DEFAULT_PRIORITY);
  feedback.textContent = "내일 아침 브리핑에 추가했어요.";
  input.focus();
});

input.addEventListener("input", () => {
  if (feedback.textContent) {
    feedback.textContent = "";
  }
});

if (logoutForm) {
  logoutForm.addEventListener("submit", handleLogoutSubmit);
}

render();

function initializeShuffleText() {
  const shuffleElements = document.querySelectorAll("[data-shuffle-text]");
  if (shuffleElements.length === 0) {
    return;
  }

  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  shuffleElements.forEach((element) => {
    const originalText = element.textContent.trim();
    element.dataset.shuffleOriginal = originalText;

    if (prefersReducedMotion || originalText.length === 0) {
      return;
    }

    let hasPlayed = false;
    let isAnimating = false;

    const playShuffle = () => {
      if (isAnimating) {
        return;
      }

      isAnimating = true;
      hasPlayed = true;
      animateShuffleText(element, () => {
        isAnimating = false;
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting || hasPlayed) {
            return;
          }

          playShuffle();
          observer.unobserve(element);
        });
      },
      {
        threshold: 0.2,
      },
    );

    observer.observe(element);

    if (element.dataset.shuffleHover === "true") {
      element.addEventListener("mouseenter", () => {
        if (!hasPlayed || isAnimating) {
          return;
        }

        playShuffle();
      });
    }
  });
}

function animateShuffleText(element, onComplete) {
  const originalText = element.dataset.shuffleOriginal || "";
  const originalChars = Array.from(originalText);
  const direction = element.dataset.shuffleDirection || "right";
  const introFrames = 6;
  let frame = 0;

  element.classList.add("is-shuffling");

  const intervalId = window.setInterval(() => {
    const revealCount = Math.max(0, frame - introFrames);
    const nextText = originalChars
      .map((character, index) => {
        if (character === " ") {
          return " ";
        }

        const revealFromLeft = direction !== "left";
        const isRevealed = revealFromLeft
          ? index < revealCount
          : index >= originalChars.length - revealCount;

        return isRevealed ? character : getRandomShuffleCharacter(character);
      })
      .join("");

    element.textContent = nextText;
    frame += 1;

    if (revealCount > originalChars.length) {
      window.clearInterval(intervalId);
      element.textContent = originalText;
      element.classList.remove("is-shuffling");
      onComplete?.();
    }
  }, 36);
}

function getRandomShuffleCharacter(character) {
  if (/[.,!?~:;()]/.test(character)) {
    return character;
  }

  const randomIndex = Math.floor(Math.random() * SHUFFLE_CHARSET.length);
  return SHUFFLE_CHARSET[randomIndex] || character;
}

function initializeTodoInputTextType() {
  const originalPlaceholder = input.getAttribute("placeholder")?.trim() || "";
  if (!originalPlaceholder) {
    return;
  }

  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReducedMotion) {
    input.placeholder = originalPlaceholder;
    return;
  }

  input.classList.add("is-text-typing");
  input.placeholder = "";

  const playTextType = () => {
    animateTodoPlaceholder(originalPlaceholder);
  };

  if (typeof IntersectionObserver !== "function") {
    playTextType();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      observer.disconnect();
      playTextType();
    },
    { threshold: 0.2 },
  );

  observer.observe(input);
}

function animateTodoPlaceholder(text) {
  const characters = Array.from(text);
  let characterIndex = 0;

  const typeNextCharacter = () => {
    if (!input.isConnected) {
      return;
    }

    characterIndex += 1;
    input.placeholder = `${characters.slice(0, characterIndex).join("")}|`;

    if (characterIndex >= characters.length) {
      blinkTodoPlaceholderCursor(text);
      return;
    }

    window.setTimeout(typeNextCharacter, TEXT_TYPE_SPEED);
  };

  window.setTimeout(typeNextCharacter, 250);
}

function blinkTodoPlaceholderCursor(text, blinkCount = 0) {
  if (!input.isConnected || blinkCount >= 4) {
    input.placeholder = text;
    input.classList.remove("is-text-typing");
    return;
  }

  input.placeholder = blinkCount % 2 === 0 ? text : `${text}|`;
  window.setTimeout(() => blinkTodoPlaceholderCursor(text, blinkCount + 1), 350);
}

function getSessionDisplayName(session) {
  const displayName =
    typeof session?.displayName === "string"
      ? session.displayName.trim()
      : typeof session?.nickname === "string"
        ? session.nickname.trim()
        : "";

  return displayName || "카카오 사용자";
}

async function handleLogoutSubmit(event) {
  event.preventDefault();

  try {
    const response = await fetch(logoutForm.action, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        Accept: "text/html",
      },
    });

    if (response.redirected && response.url) {
      window.location.assign(response.url);
      return;
    }

    if (response.ok) {
      window.location.assign("/login.html?status=logged_out");
      return;
    }
  } catch (error) {
    console.error("Failed to log out", error);
  }

  HTMLFormElement.prototype.submit.call(logoutForm);
}

function render() {
  const nextDelivery = getNextMorningDelivery();
  const sortedTasks = getSortedTasks(state.tasks, nextDelivery);
  const briefingTasks = getBriefingTasks(sortedTasks, nextDelivery);

  renderTaskList(sortedTasks, nextDelivery);
  renderBriefing(briefingTasks);
  renderSummary(sortedTasks, nextDelivery);
  renderNextDelivery(nextDelivery);
}

function renderTaskList(tasks, nextDelivery) {
  taskList.innerHTML = "";

  if (tasks.length === 0) {
    emptyState.classList.remove("is-hidden");
    return;
  }

  emptyState.classList.add("is-hidden");

  tasks.forEach((task) => {
    const isSnoozed = isTaskSnoozed(task, nextDelivery);
    const isCompleted = isTaskCompleted(task);
    const item = document.createElement("li");
    item.className = "task-item";
    if (isCompleted) {
      item.classList.add("is-completed");
    }
    if (isSnoozed) {
      item.classList.add("is-snoozed");
    }

    const row = document.createElement("div");
    row.className = "task-row";

    const title = document.createElement("p");
    title.className = "task-title text-type";
    prepareTaskTitleTextType(title, task.text);

    const pill = document.createElement("span");
    pill.className = `priority-pill ${PRIORITY_CONFIG[task.priority].pillClass}`;
    pill.textContent = PRIORITY_CONFIG[task.priority].label;

    row.append(title, pill);

    const meta = document.createElement("p");
    meta.className = "task-meta";
    meta.textContent = isCompleted
      ? `${formatCompletedAt(task.completedAt)} 완료했어요`
      : isSnoozed
        ? `${formatSnoozedUntil(task.snoozedUntil)} 아침으로 미뤘어요`
        : `${formatRelativeCreatedAt(task.createdAt)} 저장 · 내일 아침 브리핑 예정`;

    item.append(row, meta);

    if (!isCompleted) {
      const actions = document.createElement("div");
      actions.className = "task-actions";

      const completeButton = document.createElement("button");
      completeButton.type = "button";
      completeButton.className = "complete-button";
      completeButton.dataset.taskId = task.id;
      completeButton.textContent = "완료";

      actions.append(completeButton);

      if (!isSnoozed) {
        const snoozeButton = document.createElement("button");
        snoozeButton.type = "button";
        snoozeButton.className = "snooze-button";
        snoozeButton.dataset.taskId = task.id;
        snoozeButton.textContent = "하루 미루기";

        actions.append(snoozeButton);
      }

      item.append(actions);
    }

    taskList.append(item);
    initializeTaskTitleTextType(title, task);
  });
}

function prepareTaskTitleTextType(title, text) {
  const accessibleText = document.createElement("span");
  accessibleText.className = "visually-hidden";
  accessibleText.textContent = text;

  const content = document.createElement("span");
  content.className = "text-type__content";
  content.setAttribute("aria-hidden", "true");

  const cursor = document.createElement("span");
  cursor.className = "text-type__cursor";
  cursor.textContent = "|";
  cursor.setAttribute("aria-hidden", "true");

  title.append(accessibleText, content, cursor);
}

function initializeTaskTitleTextType(title, task) {
  const content = title.querySelector(".text-type__content");
  const cursor = title.querySelector(".text-type__cursor");
  const prefersReducedMotion =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (prefersReducedMotion || animatedTaskIds.has(task.id)) {
    content.textContent = task.text;
    cursor.classList.add("is-hidden");
    return;
  }

  const playTextType = () => {
    animatedTaskIds.add(task.id);
    animateTaskTitle(content, cursor, task.text);
  };

  if (typeof IntersectionObserver !== "function") {
    playTextType();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) {
        return;
      }

      observer.disconnect();
      playTextType();
    },
    { threshold: 0.2 },
  );

  observer.observe(title);
}

function animateTaskTitle(content, cursor, text) {
  const characters = Array.from(text);
  let characterIndex = 0;

  const typeNextCharacter = () => {
    if (!content.isConnected) {
      return;
    }

    characterIndex += 1;
    content.textContent = characters.slice(0, characterIndex).join("");

    if (characterIndex >= characters.length) {
      cursor.classList.add("is-finished");
      return;
    }

    window.setTimeout(typeNextCharacter, TEXT_TYPE_SPEED);
  };

  window.setTimeout(typeNextCharacter, 120);
}

function renderBriefing(tasks) {
  briefingList.innerHTML = "";

  if (tasks.length === 0) {
    const placeholder = document.createElement("li");
    placeholder.textContent = "다음 아침 브리핑에 들어갈 할 일이 없어요.";
    briefingList.append(placeholder);
    return;
  }

  tasks.slice(0, 6).forEach((task) => {
    const item = document.createElement("li");
    item.textContent = `${task.text} · ${PRIORITY_CONFIG[task.priority].label}`;
    briefingList.append(item);
  });

  if (tasks.length > 6) {
    const remaining = document.createElement("li");
    remaining.textContent = `그 밖에 ${tasks.length - 6}건이 더 있어요.`;
    briefingList.append(remaining);
  }
}

function renderSummary(tasks, nextDelivery) {
  if (tasks.length === 0) {
    taskSummary.textContent = "0건";
    return;
  }

  const activeTasks = getBriefingTasks(tasks, nextDelivery);
  const highCount = activeTasks.filter((task) => task.priority === "high").length;
  const snoozedCount = tasks.filter((task) => isTaskSnoozed(task, nextDelivery)).length;
  const completedCount = tasks.filter((task) => isTaskCompleted(task)).length;

  const statusBits = [`총 ${tasks.length}건`, `높음 ${highCount}건`];
  if (completedCount) {
    statusBits.push(`완료 ${completedCount}건`);
  }
  if (snoozedCount) {
    statusBits.push(`미룸 ${snoozedCount}건`);
  }

  taskSummary.textContent = statusBits.join(" · ");
}

function renderNextDelivery(nextDelivery) {
  nextDeliveryLabel.textContent = `${formatKoreanDate(nextDelivery)} 오전 ${formatTime(nextDelivery)} 브리핑 기준`;
}

function setSelectedPriority(priority) {
  state.selectedPriority = PRIORITY_CONFIG[priority] ? priority : DEFAULT_PRIORITY;

  chips.forEach((chip) => {
    const isSelected = chip.dataset.priority === state.selectedPriority;
    chip.classList.toggle("is-selected", isSelected);
    chip.setAttribute("aria-pressed", String(isSelected));
  });
}

function loadTasks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(isValidTaskShape);
  } catch (error) {
    console.error("Failed to load tasks", error);
    return [];
  }
}

function migrateLegacyTasks() {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) {
      return;
    }

    const legacyOwner = localStorage.getItem(LEGACY_OWNER_KEY);
    if (legacyOwner && legacyOwner !== SESSION_USER_ID) {
      return;
    }

    const legacyTasks = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!legacyTasks) {
      return;
    }

    const parsedTasks = JSON.parse(legacyTasks);
    if (!Array.isArray(parsedTasks)) {
      return;
    }

    localStorage.setItem(STORAGE_KEY, legacyTasks);
    localStorage.setItem(LEGACY_OWNER_KEY, SESSION_USER_ID);
  } catch (error) {
    console.error("Failed to migrate legacy tasks", error);
  }
}

function saveTasks(tasks) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

function isValidTaskShape(task) {
  return (
    task &&
    typeof task.id === "string" &&
    typeof task.text === "string" &&
    typeof task.createdAt === "string" &&
    typeof task.priority === "string" &&
    (typeof task.snoozedUntil === "undefined" || typeof task.snoozedUntil === "string") &&
    (typeof task.completedAt === "undefined" || typeof task.completedAt === "string") &&
    PRIORITY_CONFIG[task.priority]
  );
}

function getSortedTasks(tasks, nextDelivery) {
  return [...tasks].sort((left, right) => {
    const leftCompleted = isTaskCompleted(left);
    const rightCompleted = isTaskCompleted(right);

    if (leftCompleted !== rightCompleted) {
      return Number(leftCompleted) - Number(rightCompleted);
    }

    if (leftCompleted && rightCompleted) {
      return new Date(right.completedAt).getTime() - new Date(left.completedAt).getTime();
    }

    const leftSnoozed = isTaskSnoozed(left, nextDelivery);
    const rightSnoozed = isTaskSnoozed(right, nextDelivery);

    if (leftSnoozed !== rightSnoozed) {
      return Number(leftSnoozed) - Number(rightSnoozed);
    }

    if (leftSnoozed && rightSnoozed) {
      const snoozeDiff =
        new Date(left.snoozedUntil).getTime() - new Date(right.snoozedUntil).getTime();

      if (snoozeDiff !== 0) {
        return snoozeDiff;
      }
    }

    const priorityDiff =
      PRIORITY_CONFIG[right.priority].weight - PRIORITY_CONFIG[left.priority].weight;

    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
}

function getBriefingTasks(tasks, nextDelivery) {
  return tasks.filter((task) => !isTaskCompleted(task) && !isTaskSnoozed(task, nextDelivery));
}

function getNextMorningDelivery(baseDate = new Date(), extraDays = 0) {
  const nextMorning = new Date(baseDate);
  nextMorning.setDate(nextMorning.getDate() + 1 + extraDays);
  nextMorning.setHours(DELIVERY_HOUR, DELIVERY_MINUTE, 0, 0);
  return nextMorning;
}

function isTaskSnoozed(task, nextDelivery) {
  if (isTaskCompleted(task)) {
    return false;
  }

  if (!task.snoozedUntil) {
    return false;
  }

  return new Date(task.snoozedUntil).getTime() > nextDelivery.getTime();
}

function isTaskCompleted(task) {
  return Boolean(task.completedAt);
}

function completeTask(taskId) {
  const completedAt = new Date().toISOString();

  state.tasks = state.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          completedAt,
          snoozedUntil: undefined,
        }
      : task,
  );

  saveTasks(state.tasks);
  render();
}

function snoozeTask(taskId) {
  const snoozedUntil = getNextMorningDelivery(new Date(), 1).toISOString();

  state.tasks = state.tasks.map((task) =>
    task.id === taskId
      ? {
          ...task,
          snoozedUntil,
        }
      : task,
  );

  saveTasks(state.tasks);
  render();
}

function formatKoreanDate(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatRelativeCreatedAt(createdAt) {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const diffMinutes = Math.max(0, Math.round((now - created) / 60000));

  if (diffMinutes < 1) {
    return "방금";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}분 전`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}시간 전`;
  }

  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
  }).format(created);
}

function formatSnoozedUntil(snoozedUntil) {
  const date = new Date(snoozedUntil);
  return `${formatKoreanDate(date)} 오전 ${formatTime(date)}`;
}

function formatCompletedAt(completedAt) {
  const relative = formatRelativeCreatedAt(completedAt);
  if (relative === "방금") {
    return relative;
  }

  return `${relative}에`;
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, " ").trim();
}

function createTaskId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function resolveSessionDisplayName(session) {
  const explicitDisplayName =
    typeof session?.displayName === "string"
      ? session.displayName.trim()
      : typeof session?.nickname === "string"
        ? session.nickname.trim()
        : "";

  if (explicitDisplayName && explicitDisplayName !== "\uce74\uce74\uc624 \uc0ac\uc6a9\uc790") {
    return explicitDisplayName;
  }

  const normalizedUserId =
    typeof session?.userId === "string" ? session.userId.trim() : String(session?.userId || "").trim();

  if (!normalizedUserId) {
    return "\uce74\uce74\uc624 \uc0ac\uc6a9\uc790";
  }

  return `\uce74\uce74\uc624 \uacc4\uc815 #${normalizedUserId.slice(-6)}`;
}
