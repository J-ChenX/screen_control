import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main aria-label="Screen Control bootstrap">Screen Control</main>;
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing portal root");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

