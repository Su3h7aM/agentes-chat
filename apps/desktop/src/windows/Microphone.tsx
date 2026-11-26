import { Button, Dialog, DialogFooter, switchTheme } from "@agenteschat/ui";
import { invoke } from "@tauri-apps/api/core";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, useTranslation } from "react-i18next";
import { inTauri } from "../host/tauri";
import { loadDesktopI18n, pickLocale, systemLocale } from "../i18n";
import "../styles.css";
import "./microphone.css";

function MicrophonePrompt({ server, decide }: { server: string; decide: (allow: boolean) => Promise<void> }) {
  const { t } = useTranslation();
  const cancel = useRef<HTMLButtonElement>(null);
  const answering = useRef(false);
  const [failed, setFailed] = useState(false);
  const answer = async (allow: boolean) => {
    if (answering.current) return;
    answering.current = true;
    try {
      await decide(allow);
    } catch {
      answering.current = false;
      setFailed(true);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && void answer(false)}
      className="dk-microphone"
      width={440}
      initialFocus={cancel}
      title={t("desktop.microphone.title")}
      description={t("desktop.microphone.body", { server })}
      closeLabel={t("common.close")}
    >
      <DialogFooter note={failed ? <span role="alert">{t("desktop.common.error")}</span> : undefined}>
        <Button ref={cancel} onClick={() => void answer(false)}>
          {t("desktop.pair.notNow")}
        </Button>
        <Button variant="primary" onClick={() => void answer(true)}>
          {t("desktop.pair.allow")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

const params = new URLSearchParams(location.search);
const native = inTauri();
const server = native
  ? (window as Window & { __agentesMicrophoneServer?: string }).__agentesMicrophoneServer
  : (params.get("server") ?? "https://app.agentes.chat");
const locale = native ? systemLocale() : pickLocale([params.get("lang"), systemLocale()]);
const i18n = await loadDesktopI18n(locale, "linux");
document.documentElement.lang = i18n.language;
const dark = matchMedia("(prefers-color-scheme: dark)");
const forced = native ? null : params.get("theme");
const theme = () => switchTheme(forced === "dark" || forced === "light" ? forced : dark.matches ? "dark" : "light");
theme();
dark.addEventListener("change", theme);
const root = document.getElementById("root");
if (root && server) {
  createRoot(root).render(
    <I18nextProvider i18n={i18n}>
      <MicrophonePrompt
        server={server}
        decide={(allow) => (native ? invoke("microphone_decide", { allow }) : Promise.resolve())}
      />
    </I18nextProvider>,
  );
}
