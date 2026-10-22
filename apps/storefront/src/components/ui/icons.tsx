/**
 * Every icon the storefront shows, from one set: Hugeicons, stroke-rounded (owner
 * 2026-10-22, chosen on the icon-set comparison over Phosphor and Solar;
 * building-frontends: "icons never look stock", one set, one module). The
 * exports keep the names the code already used, so a screen imports `Plus` or
 * `Trash2` from here and gets the Hugeicons drawing. Lint refuses
 * `lucide-react` (eslint.config.mjs), so a second set cannot creep back.
 *
 * A new icon: find it in @hugeicons/core-free-icons, add one line below.
 * Each renders with `aria-hidden` (an icon beside a label is decoration; an
 * icon-only button carries its own aria-label) and the classes
 * `icon icon-<name>`, which tests may select on.
 */
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes, type SVGProps } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
// One file per icon: the package index holds all 6,075, and importing it
// cost every test file ~10s to load.
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import AlertCircleIcon from '@hugeicons/core-free-icons/AlertCircleIcon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowLeft02Icon from '@hugeicons/core-free-icons/ArrowLeft02Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import BoatIcon from '@hugeicons/core-free-icons/BoatIcon';
import Camera01Icon from '@hugeicons/core-free-icons/Camera01Icon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import ImageNotFound01Icon from '@hugeicons/core-free-icons/ImageNotFound01Icon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import LinkSquare02Icon from '@hugeicons/core-free-icons/LinkSquare02Icon';
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon';
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon';
import MinusSignIcon from '@hugeicons/core-free-icons/MinusSignIcon';
import MoreVerticalIcon from '@hugeicons/core-free-icons/MoreVerticalIcon';
import Notification01Icon from '@hugeicons/core-free-icons/Notification01Icon';
import NotificationOff01Icon from '@hugeicons/core-free-icons/NotificationOff01Icon';
import PackageIcon from '@hugeicons/core-free-icons/PackageIcon';
import PackageSearchIcon from '@hugeicons/core-free-icons/PackageSearchIcon';
import RotateLeft01Icon from '@hugeicons/core-free-icons/RotateLeft01Icon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import Share08Icon from '@hugeicons/core-free-icons/Share08Icon';
import ShoppingCart01Icon from '@hugeicons/core-free-icons/ShoppingCart01Icon';
import SmartPhone01Icon from '@hugeicons/core-free-icons/SmartPhone01Icon';
import Store01Icon from '@hugeicons/core-free-icons/Store01Icon';
import Task01Icon from '@hugeicons/core-free-icons/Task01Icon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import TranslateIcon from '@hugeicons/core-free-icons/TranslateIcon';
import UnfoldMoreIcon from '@hugeicons/core-free-icons/UnfoldMoreIcon';
import UserIcon from '@hugeicons/core-free-icons/UserIcon';
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon';
import ViewOffSlashIcon from '@hugeicons/core-free-icons/ViewOffSlashIcon';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number | string;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
}

/** Any icon from this module — what a prop or a lookup table holds. */
export type IconComponent = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

function icon(svg: IconSvgElement, name: string): IconComponent {
  const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon({ className, ...rest }, ref) {
    return (
      <HugeiconsIcon
        ref={ref}
        icon={svg}
        aria-hidden="true"
        {...rest}
        className={className ? `icon icon-${name} ${className}` : `icon icon-${name}`}
      />
    );
  });
  Icon.displayName = name;
  return Icon;
}

export const AlertCircle = icon(AlertCircleIcon, 'alert-circle');
export const ArrowLeft = icon(ArrowLeft02Icon, 'arrow-left');
export const Bell = icon(Notification01Icon, 'bell');
export const BellOff = icon(NotificationOff01Icon, 'bell-off');
export const Camera = icon(Camera01Icon, 'camera');
export const Check = icon(Tick02Icon, 'check');
export const ChevronLeft = icon(ArrowLeft01Icon, 'chevron-left');
export const ChevronRight = icon(ArrowRight01Icon, 'chevron-right');
export const ChevronsUpDown = icon(UnfoldMoreIcon, 'chevrons-up-down');
export const CircleAlert = icon(AlertCircleIcon, 'circle-alert');
export const CircleCheck = icon(CheckmarkCircle02Icon, 'circle-check');
export const ClipboardList = icon(Task01Icon, 'clipboard-list');
export const Clock = icon(Clock01Icon, 'clock');
export const ExternalLink = icon(LinkSquare02Icon, 'external-link');
export const Eye = icon(ViewIcon, 'eye');
export const EyeOff = icon(ViewOffSlashIcon, 'eye-off');
export const ImageOff = icon(ImageNotFound01Icon, 'image-off');
export const Info = icon(InformationCircleIcon, 'info');
export const Languages = icon(TranslateIcon, 'languages');
export const LoaderCircle = icon(Loading03Icon, 'loader-circle');
export const LogOut = icon(Logout01Icon, 'log-out');
export const Minus = icon(MinusSignIcon, 'minus');
export const MoreVertical = icon(MoreVerticalIcon, 'more-vertical');
export const Package = icon(PackageIcon, 'package');
export const PackageSearch = icon(PackageSearchIcon, 'package-search');
export const Plus = icon(Add01Icon, 'plus');
export const RotateCcw = icon(RotateLeft01Icon, 'rotate-ccw');
export const Search = icon(Search01Icon, 'search');
export const Share = icon(Share08Icon, 'share');
export const Ship = icon(BoatIcon, 'ship');
export const ShoppingCart = icon(ShoppingCart01Icon, 'shopping-cart');
export const Smartphone = icon(SmartPhone01Icon, 'smartphone');
export const Store = icon(Store01Icon, 'store');
export const Trash2 = icon(Delete02Icon, 'trash2');
export const User = icon(UserIcon, 'user');
export const X = icon(Cancel01Icon, 'x');
