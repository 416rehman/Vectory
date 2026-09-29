export function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "small" : ""}`}>
      <svg
        className="brand-mark"
        viewBox="0 0 28 30"
        fill="none"
        aria-hidden="true"
      >
        <path
          fill="currentColor"
          d="M1 3h6.2l7 18.6L21.2 3H27L16.4 28h-5.2L1 3Z"
        />
        <path fill="currentColor" d="M11.4 3H17l-2.8 7.3L11.4 3Z" />
      </svg>
      <span className="brand-word">Vectory</span>
    </span>
  );
}
export default Brand;
