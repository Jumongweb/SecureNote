import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import QuickCapture from "./QuickCapture";
import "./styles.css";

const quickCapture = new URLSearchParams(window.location.search).has("quick-capture");
createRoot(document.getElementById("root")!).render(<StrictMode>{quickCapture ? <QuickCapture /> : <App />}</StrictMode>);
