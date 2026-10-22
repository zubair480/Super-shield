import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import PatientApp from "./PatientApp";
import "@fontsource-variable/sora";
import "@fontsource-variable/schibsted-grotesk";
import "@fontsource/fragment-mono";
import "./index.css";

// El demo nunca muestra una pantalla blanca: si la UI truena, el worker sigue
// registrando y aquí solo se ofrece reintentar.
class Guard extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    if (!this.state.broken) return this.props.children;
    return (
      <div className="crash">
        <span className="mark" aria-hidden="true" />
        <h1>{location.pathname.startsWith("/events") ? "SuperShield Patient" : "SuperShield"}</h1>
        <p>The interface hit an error. Events are still being recorded.</p>
        <button className="retry" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    );
  }
}

// /events -> bitácora de operaciones; todo lo demás -> pantalla del paciente.
const isOps = location.pathname.startsWith("/events");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Guard>
      {isOps ? <App /> : <PatientApp />}
    </Guard>
  </StrictMode>,
);
