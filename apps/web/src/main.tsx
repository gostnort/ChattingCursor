import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initPortSettingsForEnvironment } from "./bridgeSettings";
import "./styles.css";


initPortSettingsForEnvironment();


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
