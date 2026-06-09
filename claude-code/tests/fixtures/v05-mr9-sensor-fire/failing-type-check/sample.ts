// failing-type-check fixture for t92 — type-check sensor FAILED round-trip.
//
// The local tsconfig.json enables strict mode (noImplicitAny + strict
// null checks). The const below assigns a string literal to a number-
// typed binding, producing a real tsc diagnostic
// (TS2322: Type 'string' is not assignable to type 'number') so the
// per-sensor script's errors.length > 0 check returns pass=false.
//
// Findings count derivation: dispatcher's computeFindingsCount() for
// type-check returns errors.length (after filterToFilePath()), so the
// audit row's `Findings count` field MUST equal 1.
const x: number = "string";
export const value = x;
