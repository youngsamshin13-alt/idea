const feedback = document.querySelector("#login-feedback");
const query = new URLSearchParams(window.location.search);

const errorMessages = {
  cancelled: "카카오 로그인이 취소되었어요. 원할 때 다시 시도해 주세요.",
  invalid_state: "로그인 요청을 확인할 수 없어 중단했어요. 다시 시도해 주세요.",
  kakao_failed: "카카오 로그인 연결에 실패했어요. 잠시 후 다시 시도해 주세요.",
  missing_code: "카카오 인증 정보를 받지 못했어요. 다시 시도해 주세요.",
  session_required: "할 일을 보려면 먼저 카카오로 로그인해 주세요.",
  too_many_requests: "로그인 요청이 너무 많아요. 잠시 후 다시 시도해 주세요.",
};

const errorCode = query.get("error");
if (errorCode && errorMessages[errorCode]) {
  feedback.textContent = errorMessages[errorCode];
}

if (query.get("status") === "logged_out") {
  feedback.textContent = "안전하게 로그아웃했어요.";
}

if (window.location.search) {
  window.history.replaceState(null, "", window.location.pathname);
}
