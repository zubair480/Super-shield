// Contrato B -> A: postAlert real (Composio: Slack activo, Gmail listo).
// M2: el mock local fue reemplazado por packages/notifier de Persona B.
// Con DRY_RUN=true imprime en consola en vez de enviar (Plan B en vivo).
export { postAlert } from "@farmavigia/notifier";
