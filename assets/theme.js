/* light/dark toggle: follows the device until the visitor picks one.
   picking what the device already uses goes back to automatic. */
(function () {
  const root = document.documentElement;
  const sys = matchMedia("(prefers-color-scheme: dark)"),
    tbtn = document.getElementById("theme");
  const current = () =>
    root.getAttribute("data-theme") || (sys.matches ? "dark" : "light");
  function paintToggle() {
    const dark = current() === "dark";
    document.getElementById("theme-moon").hidden = dark;
    document.getElementById("theme-sun").hidden = !dark;
    tbtn.setAttribute(
      "aria-label",
      dark ? "switch to light mode" : "switch to dark mode"
    );
  }
  tbtn.addEventListener("click", () => {
    const next = current() === "dark" ? "light" : "dark";
    // picking what the device already uses goes back to automatic
    if (next === (sys.matches ? "dark" : "light")) {
      root.removeAttribute("data-theme");
      try {
        localStorage.removeItem("paperdao-theme");
      } catch (e) {}
    } else {
      root.setAttribute("data-theme", next);
      try {
        localStorage.setItem("paperdao-theme", next);
      } catch (e) {}
    }
    paintToggle();
  });
  sys.addEventListener("change", paintToggle);
  paintToggle();
})();
