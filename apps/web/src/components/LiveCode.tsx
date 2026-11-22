import type { LiveCode, LiveOutput, LiveRun, LiveWork } from "@agenteschat/client";
import { NEAR_BOTTOM_PX } from "@agenteschat/client/lib/chat";
import { Button } from "@agenteschat/ui";
import { announce, createStickToBottom } from "@ui-sdk/core";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/lib/toast";

const KEYWORDS = new Set([
  // Python
  "def",
  "return",
  "import",
  "from",
  "as",
  "for",
  "in",
  "if",
  "elif",
  "else",
  "while",
  "class",
  "with",
  "try",
  "except",
  "finally",
  "raise",
  "lambda",
  "pass",
  "None",
  "True",
  "False",
  "and",
  "or",
  "not",
  // JS / TS / shell
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "new",
  "export",
  "null",
  "undefined",
  "true",
  "false",
  "then",
  "fi",
  "do",
  "done",
  "echo",
]);

export type CodeToken = { kind: "comment" | "string" | "keyword" | "number" | "text"; text: string };

/** A light tokenizer (no highlighter library): comments, strings, numbers and keywords; the rest is text. */
export function tokenizeCode(source: string): CodeToken[] {
  const out: CodeToken[] = [];
  const re =
    /(#[^\n]*|\/\/[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g;
  let last = 0;
  for (const m of source.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "text", text: source.slice(last, at) });
    const [all, comment, string, number, word] = m;
    if (comment) out.push({ kind: "comment", text: all });
    else if (string) out.push({ kind: "string", text: all });
    else if (number) out.push({ kind: "number", text: all });
    else if (word && KEYWORDS.has(word)) out.push({ kind: "keyword", text: all });
    else out.push({ kind: "text", text: all });
    last = at + all.length;
  }
  if (last < source.length) out.push({ kind: "text", text: source.slice(last) });
  // Merge adjacent text tokens.
  return out.reduce<CodeToken[]>((acc, tok) => {
    const prev = acc[acc.length - 1];
    if (prev && prev.kind === "text" && tok.kind === "text") prev.text += tok.text;
    else acc.push({ ...tok });
    return acc;
  }, []);
}

/** The code, mono, with the light tokens. */
export function CodeView({ code }: { code: LiveCode }) {
  const { t } = useTranslation();
  // The same few lines are drawn again on every chunk of the output under them: their tokens are made once.
  const tokens = useMemo(() => tokenizeCode(code.source), [code.source]);
  return (
    <section aria-label={t("code.source", { language: code.language })}>
      <pre className="live-code__src">
        <code>
          {tokens.map((tok, i) =>
            tok.kind === "text" ? (
              tok.text
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: static tokens of one source
              <span key={i} className={`live-code__${tok.kind}`}>
                {tok.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </section>
  );
}

/**
 * Writes a line of output as the change it is: a chunk reaches a line as the end it gained (its stream's chunks are
 * merged), which the browser shapes alone. The whole text again would make it shape every line of it, four times a
 * second. At the output's limit the line's start has moved too, and it is written again.
 */
function writeLine(node: Text, text: string) {
  const was = node.data;
  if (was === text) return;
  if (text.startsWith(was)) node.appendData(text.slice(was.length));
  else node.data = text;
}

/** The terminal-style output: stdout neutral, stderr in the danger tone; follows new output while at the bottom. */
export function OutputView({ output, live }: { output: LiveOutput[]; live?: boolean }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLPreElement>(null);
  // The scroller follows its end by itself (`createStickToBottom`): pinned while new words arrive, let go when the
  // reader scrolls up, taken up again when they come back to the end. One instance for the life of the component, so
  // a render never starts it over (a reader who scrolled up keeps their place).
  const [stick] = useState(() => createStickToBottom({ threshold: NEAR_BOTTOM_PX }));
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? stick.connect(el) : undefined;
  }, [stick]);
  // The lines are written into their own text nodes, not rendered again: one keeps what it had and gains what it
  // didn't (a running call streams up to OUTPUT_LIMIT characters into one).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    for (let i = 0; i < output.length; i++) {
      const line = el.children[i];
      const text = output[i]?.text ?? "";
      if (!line) continue;
      const node = line.firstChild;
      if (node instanceof Text) writeLine(node, text);
      else line.textContent = text;
    }
  }, [output]);
  // Once the run is over, say so: a live region added to words already on screen reads nothing, and while it streams
  // they change too fast to be read (the tool's own line says what it is doing).
  const wasLive = useRef(false);
  useEffect(() => {
    if (live) {
      wasLive.current = true;
      return;
    }
    // An output that is finished when it appears is something read, not news: nothing to announce.
    if (!wasLive.current) return;
    wasLive.current = false;
    announce(t("code.finished"));
  }, [live, t]);
  return (
    <section aria-label={t("code.output")}>
      <pre ref={ref} className="live-code__out">
        {output.length === 0 && (
          <span className="live-code__empty">{live ? t("code.waiting") : t("code.noOutput")}</span>
        )}
        {output.map((o, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: output chunks in order
          <span key={i} className={o.stream === "stderr" ? "live-code__stderr" : "live-code__stdout"} />
        ))}
      </pre>
    </section>
  );
}

/** Code + output with "copiar" (the code). Used live on the working row and in the work summary. */
export function CodePanel({
  code,
  output,
  live,
  header,
}: {
  code: LiveCode;
  output: LiveOutput[];
  live?: boolean;
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  return (
    <div className="live-code">
      <div className="live-code__bar">
        <span className="small muted">{header ?? code.language}</span>
        <span style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard?.writeText(code.source);
            toast.show(t("code.copied"));
          }}
        >
          {t("code.copy")}
        </Button>
      </div>
      <CodeView code={code} />
      <OutputView output={output} live={live} />
    </div>
  );
}

type CodeCall = Extract<LiveWork, { kind: "call" }> & { code: LiveCode };

/** The run's last call that ran code (`run_code`, a skill script), with that code's own output; none before any. */
export function lastCodeCall(run: Pick<LiveRun, "work">): CodeCall | undefined {
  const work = run.work ?? [];
  for (let i = work.length - 1; i >= 0; i--) {
    const w = work[i];
    if (w?.kind === "call" && w.code) return w as CodeCall;
  }
  return undefined;
}

/** "3,4 KB" / "820 B". */
export function formatBytes(locale: string, bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kb)} KB`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(kb / 1024)} MB`;
}
