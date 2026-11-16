export class MasterError extends Error {
  constructor(public errors: string[]) { super(errors.join("; ")); }
}
