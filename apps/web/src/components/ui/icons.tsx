/**
 * Every icon the office app shows, from one set: Hugeicons, stroke-rounded (owner
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
import Activity01Icon from '@hugeicons/core-free-icons/Activity01Icon';
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon';
import Agreement01Icon from '@hugeicons/core-free-icons/Agreement01Icon';
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon';
import Analytics01Icon from '@hugeicons/core-free-icons/Analytics01Icon';
import ArrowDataTransferHorizontalIcon from '@hugeicons/core-free-icons/ArrowDataTransferHorizontalIcon';
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon';
import ArrowDownRight01Icon from '@hugeicons/core-free-icons/ArrowDownRight01Icon';
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon';
import ArrowLeft02Icon from '@hugeicons/core-free-icons/ArrowLeft02Icon';
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon';
import ArrowRight02Icon from '@hugeicons/core-free-icons/ArrowRight02Icon';
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon';
import ArrowUpDownIcon from '@hugeicons/core-free-icons/ArrowUpDownIcon';
import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon';
import BalanceScaleIcon from '@hugeicons/core-free-icons/BalanceScaleIcon';
import BankIcon from '@hugeicons/core-free-icons/BankIcon';
import BarcodeScanIcon from '@hugeicons/core-free-icons/BarcodeScanIcon';
import BoatIcon from '@hugeicons/core-free-icons/BoatIcon';
import BookOpen01Icon from '@hugeicons/core-free-icons/BookOpen01Icon';
import Building03Icon from '@hugeicons/core-free-icons/Building03Icon';
import CalculatorIcon from '@hugeicons/core-free-icons/CalculatorIcon';
import Calendar01Icon from '@hugeicons/core-free-icons/Calendar01Icon';
import Calendar03Icon from '@hugeicons/core-free-icons/Calendar03Icon';
import CallIcon from '@hugeicons/core-free-icons/CallIcon';
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon';
import CancelCircleIcon from '@hugeicons/core-free-icons/CancelCircleIcon';
import ChartDownIcon from '@hugeicons/core-free-icons/ChartDownIcon';
import ChartUpIcon from '@hugeicons/core-free-icons/ChartUpIcon';
import CheckmarkCircle02Icon from '@hugeicons/core-free-icons/CheckmarkCircle02Icon';
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon';
import Clock04Icon from '@hugeicons/core-free-icons/Clock04Icon';
import ContractsIcon from '@hugeicons/core-free-icons/ContractsIcon';
import CreditCardIcon from '@hugeicons/core-free-icons/CreditCardIcon';
import DashboardSquare01Icon from '@hugeicons/core-free-icons/DashboardSquare01Icon';
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon';
import DiscountTag01Icon from '@hugeicons/core-free-icons/DiscountTag01Icon';
import DollarCircleIcon from '@hugeicons/core-free-icons/DollarCircleIcon';
import Download01Icon from '@hugeicons/core-free-icons/Download01Icon';
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon';
import FactoryIcon from '@hugeicons/core-free-icons/FactoryIcon';
import File02Icon from '@hugeicons/core-free-icons/File02Icon';
import FileRemoveIcon from '@hugeicons/core-free-icons/FileRemoveIcon';
import FlashIcon from '@hugeicons/core-free-icons/FlashIcon';
import ForkliftIcon from '@hugeicons/core-free-icons/ForkliftIcon';
import FuelStationIcon from '@hugeicons/core-free-icons/FuelStationIcon';
import Globe02Icon from '@hugeicons/core-free-icons/Globe02Icon';
import HourglassIcon from '@hugeicons/core-free-icons/HourglassIcon';
import ImageAdd01Icon from '@hugeicons/core-free-icons/ImageAdd01Icon';
import InboxIcon from '@hugeicons/core-free-icons/InboxIcon';
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon';
import Invoice01Icon from '@hugeicons/core-free-icons/Invoice01Icon';
import Layers01Icon from '@hugeicons/core-free-icons/Layers01Icon';
import Loading03Icon from '@hugeicons/core-free-icons/Loading03Icon';
import Location01Icon from '@hugeicons/core-free-icons/Location01Icon';
import Logout01Icon from '@hugeicons/core-free-icons/Logout01Icon';
import Mail01Icon from '@hugeicons/core-free-icons/Mail01Icon';
import Menu01Icon from '@hugeicons/core-free-icons/Menu01Icon';
import Message01Icon from '@hugeicons/core-free-icons/Message01Icon';
import MinusSignCircleIcon from '@hugeicons/core-free-icons/MinusSignCircleIcon';
import Money01Icon from '@hugeicons/core-free-icons/Money01Icon';
import MoneyReceive02Icon from '@hugeicons/core-free-icons/MoneyReceive02Icon';
import Notification01Icon from '@hugeicons/core-free-icons/Notification01Icon';
import Notification03Icon from '@hugeicons/core-free-icons/Notification03Icon';
import NotificationOff01Icon from '@hugeicons/core-free-icons/NotificationOff01Icon';
import PackageDeliveredIcon from '@hugeicons/core-free-icons/PackageDeliveredIcon';
import PackageIcon from '@hugeicons/core-free-icons/PackageIcon';
import PackageOpenIcon from '@hugeicons/core-free-icons/PackageOpenIcon';
import PackageRemoveIcon from '@hugeicons/core-free-icons/PackageRemoveIcon';
import PackageSearchIcon from '@hugeicons/core-free-icons/PackageSearchIcon';
import PencilEdit02Icon from '@hugeicons/core-free-icons/PencilEdit02Icon';
import PlugSocketIcon from '@hugeicons/core-free-icons/PlugSocketIcon';
import PowerSocket01Icon from '@hugeicons/core-free-icons/PowerSocket01Icon';
import PrinterIcon from '@hugeicons/core-free-icons/PrinterIcon';
import RoboticIcon from '@hugeicons/core-free-icons/RoboticIcon';
import RotateLeft01Icon from '@hugeicons/core-free-icons/RotateLeft01Icon';
import Route01Icon from '@hugeicons/core-free-icons/Route01Icon';
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon';
import SecurityCheckIcon from '@hugeicons/core-free-icons/SecurityCheckIcon';
import SecurityWarningIcon from '@hugeicons/core-free-icons/SecurityWarningIcon';
import SentIcon from '@hugeicons/core-free-icons/SentIcon';
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon';
import Share08Icon from '@hugeicons/core-free-icons/Share08Icon';
import ShoppingBag01Icon from '@hugeicons/core-free-icons/ShoppingBag01Icon';
import ShoppingCart01Icon from '@hugeicons/core-free-icons/ShoppingCart01Icon';
import Store01Icon from '@hugeicons/core-free-icons/Store01Icon';
import Tag01Icon from '@hugeicons/core-free-icons/Tag01Icon';
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon';
import TickDouble02Icon from '@hugeicons/core-free-icons/TickDouble02Icon';
import TruckDeliveryIcon from '@hugeicons/core-free-icons/TruckDeliveryIcon';
import UnavailableIcon from '@hugeicons/core-free-icons/UnavailableIcon';
import Undo02Icon from '@hugeicons/core-free-icons/Undo02Icon';
import UnfoldMoreIcon from '@hugeicons/core-free-icons/UnfoldMoreIcon';
import Unlink04Icon from '@hugeicons/core-free-icons/Unlink04Icon';
import UserGroupIcon from '@hugeicons/core-free-icons/UserGroupIcon';
import UserIcon from '@hugeicons/core-free-icons/UserIcon';
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon';
import ViewOffSlashIcon from '@hugeicons/core-free-icons/ViewOffSlashIcon';
import Wallet01Icon from '@hugeicons/core-free-icons/Wallet01Icon';
import WarehouseIcon from '@hugeicons/core-free-icons/WarehouseIcon';

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

export const Activity = icon(Activity01Icon, 'activity');
export const AlertTriangle = icon(Alert02Icon, 'alert-triangle');
export const ArrowDownRight = icon(ArrowDownRight01Icon, 'arrow-down-right');
export const ArrowLeft = icon(ArrowLeft02Icon, 'arrow-left');
export const ArrowLeftRight = icon(ArrowDataTransferHorizontalIcon, 'arrow-left-right');
export const ArrowRight = icon(ArrowRight02Icon, 'arrow-right');
export const ArrowRightLeft = icon(ArrowDataTransferHorizontalIcon, 'arrow-right-left');
export const ArrowUpDown = icon(ArrowUpDownIcon, 'arrow-up-down');
export const ArrowUpRight = icon(ArrowUpRight01Icon, 'arrow-up-right');
export const BadgePercent = icon(DiscountTag01Icon, 'badge-percent');
export const Ban = icon(UnavailableIcon, 'ban');
export const Banknote = icon(Money01Icon, 'banknote');
export const BarChart3 = icon(Analytics01Icon, 'bar-chart3');
export const Barcode = icon(BarcodeScanIcon, 'barcode');
export const Bell = icon(Notification01Icon, 'bell');
export const BellOff = icon(NotificationOff01Icon, 'bell-off');
export const BellRing = icon(Notification03Icon, 'bell-ring');
export const BookOpen = icon(BookOpen01Icon, 'book-open');
export const Bot = icon(RoboticIcon, 'bot');
export const Boxes = icon(Layers01Icon, 'boxes');
export const Building2 = icon(Building03Icon, 'building2');
export const Calculator = icon(CalculatorIcon, 'calculator');
export const CalendarClock = icon(Calendar03Icon, 'calendar-clock');
export const CalendarDays = icon(Calendar01Icon, 'calendar-days');
export const Check = icon(Tick02Icon, 'check');
export const CheckCheck = icon(TickDouble02Icon, 'check-check');
export const CheckCircle = icon(CheckmarkCircle02Icon, 'check-circle');
export const CheckCircle2 = icon(CheckmarkCircle02Icon, 'check-circle2');
export const ChevronDown = icon(ArrowDown01Icon, 'chevron-down');
export const ChevronLeft = icon(ArrowLeft01Icon, 'chevron-left');
export const ChevronRight = icon(ArrowRight01Icon, 'chevron-right');
export const ChevronUp = icon(ArrowUp01Icon, 'chevron-up');
export const ChevronsUpDown = icon(UnfoldMoreIcon, 'chevrons-up-down');
export const Clock = icon(Clock01Icon, 'clock');
export const CreditCard = icon(CreditCardIcon, 'credit-card');
export const DollarSign = icon(DollarCircleIcon, 'dollar-sign');
export const Download = icon(Download01Icon, 'download');
export const Edit = icon(Edit02Icon, 'edit');
export const Eye = icon(ViewIcon, 'eye');
export const EyeOff = icon(ViewOffSlashIcon, 'eye-off');
export const Factory = icon(FactoryIcon, 'factory');
export const FileSignature = icon(ContractsIcon, 'file-signature');
export const FileText = icon(File02Icon, 'file-text');
export const FileX = icon(FileRemoveIcon, 'file-x');
export const Forklift = icon(ForkliftIcon, 'forklift');
export const Fuel = icon(FuelStationIcon, 'fuel');
export const Globe = icon(Globe02Icon, 'globe');
export const HandCoins = icon(MoneyReceive02Icon, 'hand-coins');
export const Handshake = icon(Agreement01Icon, 'handshake');
export const History = icon(Clock04Icon, 'history');
export const Hourglass = icon(HourglassIcon, 'hourglass');
export const ImagePlus = icon(ImageAdd01Icon, 'image-plus');
export const Inbox = icon(InboxIcon, 'inbox');
export const Info = icon(InformationCircleIcon, 'info');
export const Landmark = icon(BankIcon, 'landmark');
export const Layers = icon(Layers01Icon, 'layers');
export const LayoutDashboard = icon(DashboardSquare01Icon, 'layout-dashboard');
export const Loader2 = icon(Loading03Icon, 'loader2');
export const LogOut = icon(Logout01Icon, 'log-out');
export const Mail = icon(Mail01Icon, 'mail');
export const MapPin = icon(Location01Icon, 'map-pin');
export const Menu = icon(Menu01Icon, 'menu');
export const MessageCircle = icon(Message01Icon, 'message-circle');
export const MinusCircle = icon(MinusSignCircleIcon, 'minus-circle');
export const Package = icon(PackageIcon, 'package');
export const PackageCheck = icon(PackageDeliveredIcon, 'package-check');
export const PackageOpen = icon(PackageOpenIcon, 'package-open');
export const PackageSearch = icon(PackageSearchIcon, 'package-search');
export const PackageX = icon(PackageRemoveIcon, 'package-x');
export const PencilLine = icon(PencilEdit02Icon, 'pencil-line');
export const Phone = icon(CallIcon, 'phone');
export const Plus = icon(Add01Icon, 'plus');
export const Power = icon(PowerSocket01Icon, 'power');
export const PowerOff = icon(PlugSocketIcon, 'power-off');
export const Printer = icon(PrinterIcon, 'printer');
export const Receipt = icon(Invoice01Icon, 'receipt');
export const RotateCcw = icon(RotateLeft01Icon, 'rotate-ccw');
export const Route = icon(Route01Icon, 'route');
export const Scale = icon(BalanceScaleIcon, 'scale');
export const Search = icon(Search01Icon, 'search');
export const Send = icon(SentIcon, 'send');
export const Settings = icon(Settings01Icon, 'settings');
export const Share = icon(Share08Icon, 'share');
export const Share2 = icon(Share08Icon, 'share2');
export const ShieldAlert = icon(SecurityWarningIcon, 'shield-alert');
export const ShieldCheck = icon(SecurityCheckIcon, 'shield-check');
export const Ship = icon(BoatIcon, 'ship');
export const ShoppingBag = icon(ShoppingBag01Icon, 'shopping-bag');
export const ShoppingCart = icon(ShoppingCart01Icon, 'shopping-cart');
export const Store = icon(Store01Icon, 'store');
export const Tag = icon(Tag01Icon, 'tag');
export const Trash2 = icon(Delete02Icon, 'trash2');
export const TrendingDown = icon(ChartDownIcon, 'trending-down');
export const TrendingUp = icon(ChartUpIcon, 'trending-up');
export const Truck = icon(TruckDeliveryIcon, 'truck');
export const Undo2 = icon(Undo02Icon, 'undo2');
export const Unplug = icon(Unlink04Icon, 'unplug');
export const User = icon(UserIcon, 'user');
export const Users = icon(UserGroupIcon, 'users');
export const Wallet = icon(Wallet01Icon, 'wallet');
export const Warehouse = icon(WarehouseIcon, 'warehouse');
export const X = icon(Cancel01Icon, 'x');
export const XCircle = icon(CancelCircleIcon, 'xcircle');
export const Zap = icon(FlashIcon, 'zap');
