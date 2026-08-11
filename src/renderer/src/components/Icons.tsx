import { JSX } from 'react'

/** Inline 16px stroke icons. Inline SVG keeps the CSP tight — no icon font. */

interface Props {
  size?: number
}

const svg = (path: JSX.Element, size = 16): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {path}
  </svg>
)

export const MenuIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <line x1="2.5" y1="4" x2="13.5" y2="4" />
      <line x1="2.5" y1="8" x2="13.5" y2="8" />
      <line x1="2.5" y1="12" x2="13.5" y2="12" />
    </>,
    size
  )

export const GearIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7L3.5 3.5" />
    </>,
    size
  )

export const PlugIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M6 1.8v3.4M10 1.8v3.4" />
      <path d="M3.9 5.2h8.2v2.6a4.1 4.1 0 0 1-4.1 4.1 4.1 4.1 0 0 1-4.1-4.1z" />
      <path d="M8 11.9v2.3" />
    </>,
    size
  )

export const PlusIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </>,
    size
  )

export const SendIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M14 8L2.5 2.6l2.1 5.4-2.1 5.4z" />
      <path d="M4.6 8H14" />
    </>,
    size
  )

export const StopIcon = ({ size }: Props): JSX.Element =>
  svg(<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />, size)

export const MicIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0" />
      <path d="M8 11.8v2.4" />
    </>,
    size
  )

export const WaveIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M2 7v2M5 4.5v7M8 2.5v11M11 4.5v7M14 7v2" />
    </>,
    size
  )

export const ChevronIcon = ({ size }: Props): JSX.Element =>
  svg(<path d="M6 3.5L10.5 8 6 12.5" />, size)

export const FolderIcon = ({ size }: Props): JSX.Element =>
  svg(<path d="M1.8 12.6V3.4h4.1l1.4 1.7h6.9v7.5z" />, size)

export const FileIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M3.6 1.8h5.3l3.5 3.5v8.9H3.6z" />
      <path d="M8.9 1.8v3.5h3.5" />
    </>,
    size
  )

export const CloseIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
      <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
    </>,
    size
  )

/** Adds a pane to the right: the divider runs vertically. */
export const SplitRightIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.4" />
      <line x1="8" y1="2" x2="8" y2="14" />
    </>,
    size
  )

/** Adds a pane below: the divider runs horizontally. */
export const SplitDownIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <rect x="2" y="2" width="12" height="12" rx="1.4" />
      <line x1="2" y1="8" x2="14" y2="8" />
    </>,
    size
  )

export const GlobeIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4M8 1.8c1.7 1.8 2.6 3.9 2.6 6.2S9.7 12.4 8 14.2C6.3 12.4 5.4 10.3 5.4 8S6.3 3.6 8 1.8z" />
    </>,
    size
  )

export const TerminalIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M2.8 4.5L6 8l-3.2 3.5" />
      <line x1="7.5" y1="11.5" x2="13" y2="11.5" />
    </>,
    size
  )

export const NewWindowIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <rect x="2" y="4" width="9.5" height="9.5" rx="1.3" />
      <path d="M5 4V2.5h8.5V11H12" />
    </>,
    size
  )

export const TrashIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M2.8 4.2h10.4" />
      <path d="M6.3 4.2V2.8h3.4v1.4" />
      <path d="M4.2 4.2l.7 9h6.2l.7-9" />
    </>,
    size
  )

export const CheckIcon = ({ size }: Props): JSX.Element =>
  svg(<path d="M3 8.4l3.3 3.3L13 5" />, size)

export const WarnIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.8v3.6" />
      <circle cx="8" cy="11.1" r="0.55" fill="currentColor" stroke="none" />
    </>,
    size
  )

export const DotIcon = ({ size }: Props): JSX.Element =>
  svg(<circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />, size)

export const RefreshIcon = ({ size }: Props): JSX.Element =>
  svg(
    <>
      <path d="M13.6 7a5.7 5.7 0 1 0-.5 3.3" />
      <path d="M13.9 3.2v3.9h-3.9" />
    </>,
    size
  )
