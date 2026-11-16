export function Errors({ errors }: { errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <div className="errors" role="alert">
      {errors.length === 1 ? errors[0] : <ul>{errors.slice(0, 50).map((e, i) => <li key={i}>{e}</li>)}</ul>}
      {errors.length > 50 && <div>…and {errors.length - 50} more</div>}
    </div>
  );
}
