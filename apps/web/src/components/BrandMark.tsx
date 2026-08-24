type BrandMarkProps = {
  className?: string;
  size?: number;
};

export const BrandMark = ({ className, size = 24 }: BrandMarkProps): React.JSX.Element => (
  <svg
    aria-hidden="true"
    className={className}
    focusable="false"
    height={size}
    viewBox="0 0 96 96"
    width={size}
  >
    <rect fill="#5e6ad2" height="96" rx="24" width="96" />
    <path
      d="M27 23v46h46"
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="10"
    />
    <path
      d="M48 23v25h25"
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="10"
    />
  </svg>
);
