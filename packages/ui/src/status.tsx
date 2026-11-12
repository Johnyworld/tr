import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StatusApp } from "./StatusApp.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StatusApp />
  </StrictMode>,
);
