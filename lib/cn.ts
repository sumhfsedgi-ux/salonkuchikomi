// Tiny classname-join helper -- intentionally not the `clsx` package. The
// only thing every usage in this codebase needs is "join truthy strings with
// a space", so a one-line local helper avoids adding a dependency for it.
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
