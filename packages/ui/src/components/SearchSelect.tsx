import { createListbox } from "@ui-sdk/core";
import { Popover as RPopover } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { cx } from "../cx";
import { EDGE_ROOM } from "../floating";
import { rankedScore } from "../search";
import { useFieldControl } from "./Field";
import { SearchMark } from "./SearchMark";
import { ChosenValue, type SelectOption } from "./Select";
import { SearchField } from "./Toolbar";

export interface SearchSelectLabels {
  /** Accessible name of the search field ("Buscar modelos"). */
  search: string;
  searchPlaceholder: string;
  noResults: string;
  /** With no option at all and nothing typed; default: `noResults`. */
  empty?: string;
  /** Accessible name of the list ("Modelos"). */
  list: string;
}

export interface SearchSelectProps<V extends string = string, O extends SelectOption<V> = SelectOption<V>> {
  value: V | undefined;
  onValueChange: (value: V) => void;
  /** Consecutive options with the same `group` get a heading. A function is read only while the list is open. */
  options: O[] | (() => O[]);
  labels: SearchSelectLabels;
  /** A group's heading; default: the group as given. */
  groupLabel?: (group: string) => string;
  /**
   * How an option answers what was typed: a score ranks it (above 0 answers,
   * best first), `true` keeps it in place. Default: a ranked score over its
   * label, value and group.
   */
  matches?: (option: O, query: string) => boolean | number;
  /** A row before its check; default: its leading mark, label and description, as `Select` draws them. */
  renderOption?: (option: O) => ReactNode;
  /** What the trigger shows; default: the chosen option's face or logo and its label, as `Select`'s, else `placeholder`. */
  renderValue?: (option: O | undefined) => ReactNode;
  placeholder?: string;
  /**
   * Under the list, always (also while searching, also with no option): what to do when what is sought isn't there
   * ("Add account"). `close` shuts the list first.
   */
  footer?: (close: () => void) => ReactNode;
  /** Opens with the list shown (a link that leads straight to the choice). */
  defaultOpen?: boolean;
  id?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

const defaultMatches = (o: SelectOption, query: string) => rankedScore(`${o.label} ${o.value} ${o.group ?? ""}`, query);

const DefaultRow = ({ option, query }: { option: SelectOption; query: string }) => (
  <>
    {option.leading && (
      <span className="ac-menu__leading" aria-hidden="true">
        {option.leading}
      </span>
    )}
    <span className="ac-menu__label">
      <span>
        <SearchMark text={option.label} query={query} />
      </span>
      {option.description && <span className="ac-menu__desc">{option.description}</span>}
    </span>
  </>
);

/** Runs of consecutive options by `group`. */
function groupsOf<O extends SelectOption>(options: O[]) {
  const out: [string | undefined, O[]][] = [];
  for (const o of options) {
    const last = out[out.length - 1];
    if (last && last[0] === o.group) last[1].push(o);
    else out.push([o.group, [o]]);
  }
  return out;
}

type Highlighted = { highlighted: string | null };

/**
 * One choice from a long list: our trigger, then a glass dropdown with a search over the options, in their groups,
 * the chosen one checked. Combobox semantics, arrows / Home / End / Page keys / Enter / Esc, `aria-activedescendant`.
 * The highlight skips disabled options (they show, but can't be picked) and wraps around; moving it scrolls only the
 * list. Typing ranks the options, best first, and marks the match. `footer` stays under the list whatever is typed.
 */
export function SearchSelect<V extends string = string, O extends SelectOption<V> = SelectOption<V>>({
  value,
  onValueChange,
  options,
  labels,
  groupLabel = (group) => group,
  matches = defaultMatches,
  renderOption,
  renderValue,
  placeholder,
  footer,
  defaultOpen = false,
  id,
  disabled,
  className,
  ...rest
}: SearchSelectProps<V, O>) {
  const wiring = useFieldControl({ id });
  const listId = useId();
  const [open, setOpen] = useState(false);
  // Asked to open shown: once, as soon as it can be used (a list still loading starts disabled).
  const shownOnce = useRef(false);
  useEffect(() => {
    if (!defaultOpen || disabled || shownOnce.current) return;
    shownOnce.current = true;
    setOpen(true);
  }, [defaultOpen, disabled]);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const highlightedRef = useRef<string | null>(null);
  const all = useMemo(() => (Array.isArray(options) ? options : open ? options() : []), [options, open]);
  const flat = useMemo(() => {
    if (!query.trim()) return all;
    return all
      .map((o) => {
        const found = matches(o, query);
        return { o, score: typeof found === "number" ? found : found ? 1 : 0 };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.o);
  }, [all, query, matches]);
  const flatRef = useRef(flat);
  flatRef.current = flat;
  const groups = useMemo(() => groupsOf(flat), [flat]);
  const chosen = Array.isArray(options) ? options.find((o) => o.value === value) : undefined;

  // The listbox owns the highlight: virtual focus (it stays in the search field), looping, disabled options skipped,
  // and the highlighted row kept in view. Filtering and ranking stay here, over `flat`.
  const listbox = useMemo(
    () =>
      createListbox(
        {
          id: listId,
          store: {
            get: (): Highlighted => ({ highlighted: highlightedRef.current }),
            set: (patch: Highlighted) => {
              highlightedRef.current = patch.highlighted;
              setHighlighted(patch.highlighted);
            },
          },
        } as never,
        {
          key: "highlighted",
          focus: "virtual",
          items: () => flatRef.current.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled })),
          query: () => "",
          filter: () => false,
          loop: () => true,
        },
      ),
    [listId],
  );

  // Opening starts on the chosen option (when it can be picked), else the first pickable one; typing goes back to
  // the first match. Only the option keys matter: a parent re-render with the same options keeps the highlight.
  const openedRef = useRef(false);
  const keysRef = useRef("");
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    const keys = flat.map((o) => o.value).join("\0");
    if (!openedRef.current) {
      // A stale query narrows the fresh list: clear it first, highlight once the full list is back.
      if (query) {
        setQuery("");
        return;
      }
      openedRef.current = true;
      keysRef.current = keys;
      const start = all.find((o) => o.value === value);
      if (start && !start.disabled) listbox.highlight(start.value);
      else listbox.move("first");
    } else if (keys !== keysRef.current) {
      keysRef.current = keys;
      listbox.move("first");
    }
  }, [open, flat, all, value, listbox, query]);
  // Opening brings the whole popup into view, once: the page moves only then, never for a choice or a key.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(listId)?.parentElement?.scrollIntoView?.({ block: "nearest" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [open, listId]);

  const pick = (o: O | undefined) => {
    if (!o || o.disabled) return;
    onValueChange(o.value);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Arrows and Page keys move through the options, skipping the disabled ones; Enter and Home/End are ours.
    const moved = listbox.keydown(e.nativeEvent);
    if (moved !== undefined) return;
    if (e.key === "Home") {
      e.preventDefault();
      listbox.move("first");
    } else if (e.key === "End") {
      e.preventDefault();
      listbox.move("last");
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = flatRef.current.find((o) => o.value === highlightedRef.current);
      pick(current ?? flatRef.current.find((o) => !o.disabled));
    }
  };

  const state = { highlighted };
  return (
    <div className={cx("ac-select", className)}>
      <RPopover.Root open={open} onOpenChange={setOpen}>
        <RPopover.Trigger asChild disabled={disabled}>
          <button
            type="button"
            className="ac-select__trigger"
            id={wiring.id}
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={rest["aria-label"]}
            aria-describedby={wiring["aria-describedby"]}
            aria-invalid={wiring["aria-invalid"]}
            onKeyDown={(e) => {
              // The keys that open `Select`'s list open this one too.
              if (open || !["Enter", " ", "ArrowDown", "ArrowUp"].includes(e.key)) return;
              e.preventDefault();
              setOpen(true);
            }}
          >
            <span className="ac-select__value">
              {renderValue ? (
                renderValue(chosen)
              ) : chosen ? (
                <span>
                  <ChosenValue option={chosen} />
                </span>
              ) : (
                placeholder
              )}
            </span>
            <svg className="ac-select__chev" viewBox="0 0 20 20" aria-hidden="true">
              <path d="m6 8 4 4 4-4" />
            </svg>
          </button>
        </RPopover.Trigger>
        <RPopover.Portal>
          <RPopover.Content className="ac-menu ac-tz__menu" align="start" sideOffset={4} collisionPadding={EDGE_ROOM}>
            <div className="ac-tz__searchrow">
              <SearchField
                size="sm"
                role="combobox"
                aria-label={labels.search}
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={flat.length ? listbox.activeId(state) : undefined}
                placeholder={labels.searchPlaceholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKey}
              />
            </div>
            <div className="ac-tz__list ac-search__list" role="listbox" id={listId} aria-label={labels.list}>
              {flat.length === 0 && (
                <p className="ac-tz__empty">{query.trim() ? labels.noResults : (labels.empty ?? labels.noResults)}</p>
              )}
              {groups.map(([group, list], g) => {
                const rows = list.map((o) => {
                  const part = { key: o.value, props: { value: o.value, label: o.label, disabled: o.disabled } };
                  const attrs = listbox.attrs(state, part);
                  return (
                    // biome-ignore lint/a11y/useFocusableInteractive: options are reached through aria-activedescendant
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the search field handles the keys
                    <div
                      key={o.value}
                      ref={(el) => {
                        if (el) return listbox.bind(el, part);
                      }}
                      id={attrs.id}
                      role="option"
                      aria-selected={o.value === value}
                      aria-disabled={o.disabled || undefined}
                      data-highlighted={attrs["data-highlighted"]}
                      data-active={o.value === highlighted || undefined}
                      className={cx("ac-tz__option", !renderOption && "ac-search__option")}
                      onPointerMove={() => {
                        if (!o.disabled) listbox.highlight(o.value);
                      }}
                      onClick={() => pick(o)}
                    >
                      {renderOption ? renderOption(o) : <DefaultRow option={o} query={query} />}
                    </div>
                  );
                });
                return group ? (
                  // biome-ignore lint/a11y/useSemanticElements: a listbox group
                  <div key={group} role="group" aria-label={groupLabel(group)}>
                    <div className="ac-menu__heading" aria-hidden="true">
                      {groupLabel(group)}
                    </div>
                    {rows}
                  </div>
                ) : (
                  // biome-ignore lint/suspicious/noArrayIndexKey: ungrouped runs have nothing else to tell them apart
                  <div key={`~${g}`}>{rows}</div>
                );
              })}
            </div>
            {footer && (
              <div className="ac-tz__foot">
                {/* biome-ignore lint/a11y/useSemanticElements: a menu's separator, drawn as every menu's */}
                <div className="ac-menu__separator" role="separator" />
                {footer(() => setOpen(false))}
              </div>
            )}
          </RPopover.Content>
        </RPopover.Portal>
      </RPopover.Root>
    </div>
  );
}
