import { highlightSegments } from "../search";

/**
 * A label with its match for a search box highlighted: the ranges the query
 * matched render as `<mark>`, the rest as given. Plain text when nothing
 * matches (a match through keywords, or no query).
 */
export function SearchMark({ text, query }: { text: string; query: string }) {
  const segments = highlightSegments(text, query);
  if (segments.every((segment) => !segment.match)) return <>{text}</>;
  let at = 0;
  const parts = segments.map((segment) => {
    const start = at;
    at += segment.text.length;
    return { ...segment, start };
  });
  return (
    <>
      {parts.map((part) =>
        part.match ? (
          <mark key={part.start} className="ac-search__mark">
            {part.text}
          </mark>
        ) : (
          <span key={part.start}>{part.text}</span>
        ),
      )}
    </>
  );
}
