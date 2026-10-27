import Link from "next/link";
import { CookingPot } from "lucide-react";
export default function NotFound() {
  return <main id="main" className="empty-state page-width" style={{ minHeight: "70vh", paddingTop: "18vh" }}><CookingPot size={56} strokeWidth={1.2} /><h1>Ten przepis jeszcze się gotuje.</h1><p>Recipe not found.</p><Link href="/pl" className="primary-button">Wróć do przepisów / Back to recipes</Link></main>;
}
