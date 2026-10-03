/**
 * The control a finding's field path points at. Vector's schema nests some
 * settings one level deeper in the form than the configuration writes them: a
 * bearer token is `auth.token` in the configuration and `auth.auth.token` in
 * its form. A path with no control of its own therefore matches the one
 * control that ends in the same setting and passes through the same names in
 * order. Two such controls, or none, match nothing: a jump never guesses.
 */
export function controlPathFor(
  field: string,
  paths: readonly string[],
): string | undefined {
  if (paths.includes(field)) return field;
  const wanted = field.split(".");
  const near = paths.filter((path) => {
    const parts = path.split(".");
    if (parts.length <= wanted.length || parts.at(-1) !== wanted.at(-1))
      return false;
    let matched = 0;
    for (const part of parts) if (part === wanted[matched]) matched++;
    return matched === wanted.length;
  });
  return near.length === 1 ? near[0] : undefined;
}
