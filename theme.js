/* The preference is independent of financial data; blocked storage is harmless. */
(function () {
  "use strict";
  const key = "gamarji.theme";
  let theme = "light";
  try { if (localStorage.getItem(key) === "dark") theme = "dark"; } catch {}
  function apply() {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#11151b" : "#faf9f6";
    const button = document.getElementById("themeToggle");
    if (button) {
      button.textContent = theme === "dark" ? "Светлая тема" : "Тёмная тема";
      button.setAttribute("aria-label", "Включить " + (theme === "dark" ? "светлую" : "тёмную") + " тему");
    }
  }
  apply();
  document.addEventListener("DOMContentLoaded", () => {
    apply();
    document.getElementById("themeToggle")?.addEventListener("click", () => {
      theme = theme === "light" ? "dark" : "light";
      try { localStorage.setItem(key, theme); } catch {}
      apply();
    });
  });
})();
