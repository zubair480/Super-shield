// App shell: hash router + portal switch. Owned by the foundation.
// Routes: #/pharmacy/<page>[/<id>]  and  #/patient/<page>[/<id>]
(function () {
  const { useState, useEffect } = React;
  const { html, ui } = window.SS;

  const parse = () => {
    const parts = (location.hash.replace(/^#\/?/, "") || "pharmacy").split("/").map(decodeURIComponent);
    return { portal: parts[0] === "patient" ? "patient" : "pharmacy", page: parts[1] || "", id: parts[2] || "", query: parts.slice(3) };
  };
  const navigate = (path) => { location.hash = "#/" + path.replace(/^#?\/?/, ""); };

  function PortalSwitch({ portal }) {
    return html`<div className="ss-switch" role="tablist" aria-label="Portal">
      <a role="tab" aria-selected=${portal === "pharmacy"} className=${portal === "pharmacy" ? "on" : ""} href="#/pharmacy">
        <${ui.Icon} name="building-hospital" />Pharmacy</a>
      <a role="tab" aria-selected=${portal === "patient"} className=${portal === "patient" ? "on" : ""} href="#/patient">
        <${ui.Icon} name="heart-rate-monitor" />My Health</a>
    </div>`;
  }

  function App() {
    const [route, setRoute] = useState(parse());
    useEffect(() => {
      const on = () => { setRoute(parse()); window.scrollTo(0, 0); };
      window.addEventListener("hashchange", on); return () => window.removeEventListener("hashchange", on);
    }, []);
    const Portal = window.SS.portals[route.portal];
    return html`<div className=${`ss-app ss-portal-${route.portal}`}>
      <${PortalSwitch} portal=${route.portal} />
      ${Portal ? html`<${Portal} route=${route} navigate=${navigate} />`
               : html`<${ui.Empty} icon="tools" title="This portal isn't built yet" />`}
      <${ui.Toasts} />
    </div>`;
  }

  window.SS.navigate = navigate;
  ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
})();
