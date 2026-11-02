import type { Config } from "../api";

type Theme = Config["theme"];
const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
let current: Theme = "auto";
const effective = (t: Theme) => (t === "auto" ? (mq?.matches ? "dark" : "light") : t);
mq?.addEventListener("change", () => { if (current === "auto") document.documentElement.dataset.theme = effective("auto"); });

/** Writes the effective theme to `<html data-theme>`; `auto` follows `prefers-color-scheme` live. */
export function applyTheme(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = effective(t);
}

const OPTS: { t: Theme; label: string; title: string }[] = [
  { t: "light", label: "☀", title: "Light" },
  { t: "dark", label: "☾", title: "Dark" },
  { t: "auto", label: "Auto", title: "Follow OS" },
];

export function ThemeSwitch({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label="Theme">
      {OPTS.map((o) => (
        <button key={o.t} type="button" role="radio" aria-checked={value === o.t} aria-label={o.title} title={o.title} className={value === o.t ? "on" : ""}
          onClick={() => { applyTheme(o.t); onChange(o.t); }}>{o.label}</button>
      ))}
    </div>
  );
}
