// Pharmacy portal. Owned by the pharmacy UI session (see CONTRACT.md).
(function () {
  const { html, ui } = window.SS;
  function Portal({ route }) {
    return html`<div className="ss-empty" style=${{ padding: 80 }}><b>Pharmacy portal</b><p>Being built. Route: ${route.page || "home"}</p></div>`;
  }
  window.SS.register("pharmacy", Portal);
})();
