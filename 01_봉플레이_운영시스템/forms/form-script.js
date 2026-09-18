/* 봉플레이 서식 공통 스크립트 */
document.querySelectorAll(".f").forEach(el => {
  el.setAttribute("contenteditable", "true");
  el.addEventListener("paste", e => {            // 서식 없이 붙여넣기
    e.preventDefault();
    document.execCommand("insertText", false,
      (e.clipboardData || window.clipboardData).getData("text"));
  });
});

// 칸 아무 데나 눌러도 커서가 잡히도록 (태블릿 대응)
document.querySelectorAll("td").forEach(td => {
  td.addEventListener("click", e => {
    if (e.target === td) td.querySelector(".f")?.focus();
  });
});

// 오늘 날짜 자동 채우기 버튼용
function fillToday(id) {
  const d = new Date();
  const el = document.getElementById(id);
  if (el) el.textContent = `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일`;
}
