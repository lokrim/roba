/**
 * ControlDashboard — the full operator settings surface, mounted on the /control route.
 * Left sidebar selects a section; right area renders the purpose-built editor.
 * Each section is lazy-rendered (unmounted when not selected) to keep initial load fast.
 */
import { useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  BookOpen,
  Cloud,
  Cpu,
  Database,
  FlaskConical,
  Globe,
  Package,
  Settings2,
  Truck,
  Users,
} from "lucide-react";
import { PosMixPanel } from "./control/PosMixPanel";
import { AnomaliesPanel } from "./control/AnomaliesPanel";
import { WeatherControl } from "./control/WeatherControl";
import { SimConfigPanel } from "./control/SimConfig";
import { ScenariosPanel } from "./control/ScenariosPanel";
import { SeedManager } from "./control/SeedManager";
import { MenuRecipeEditor } from "./control/MenuRecipeEditor";
import { IngredientsInventory } from "./control/IngredientsInventory";
import { SuppliersEditor } from "./control/SuppliersEditor";
import { StaffStations } from "./control/StaffStations";
import { CompetitorsReviews } from "./control/CompetitorsReviews";
import { ForecastControls } from "./control/ForecastControls";
import { AdvancedEntities } from "./control/AdvancedEntities";

// ---------------------------------------------------------------------------
// Section definition
// ---------------------------------------------------------------------------

interface Section {
  id: string;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

const SECTIONS: Section[] = [
  {
    id: "simulation",
    label: "Simulation",
    icon: <Settings2 size={15} />,
    content: (
      <div className="space-y-10">
        <SimConfigPanel />
        <div className="border-t border-muted pt-8">
          <ScenariosPanel />
        </div>
      </div>
    ),
  },
  {
    id: "seed",
    label: "Seed & Restaurant",
    icon: <Database size={15} />,
    content: <SeedManager />,
  },
  {
    id: "pos",
    label: "POS Generation",
    icon: <Activity size={15} />,
    content: <PosMixPanel />,
  },
  {
    id: "anomalies",
    label: "Anomalies",
    icon: <AlertTriangle size={15} />,
    content: <AnomaliesPanel />,
  },
  {
    id: "weather",
    label: "Weather",
    icon: <Cloud size={15} />,
    content: <WeatherControl />,
  },
  {
    id: "menu",
    label: "Menu & Recipes",
    icon: <BookOpen size={15} />,
    content: <MenuRecipeEditor />,
  },
  {
    id: "inventory",
    label: "Ingredients & Inventory",
    icon: <Package size={15} />,
    content: <IngredientsInventory />,
  },
  {
    id: "suppliers",
    label: "Suppliers",
    icon: <Truck size={15} />,
    content: <SuppliersEditor />,
  },
  {
    id: "staff",
    label: "Staff & Stations",
    icon: <Users size={15} />,
    content: <StaffStations />,
  },
  {
    id: "competitors",
    label: "Competitors & Reviews",
    icon: <Globe size={15} />,
    content: <CompetitorsReviews />,
  },
  {
    id: "forecast",
    label: "Forecast",
    icon: <Cpu size={15} />,
    content: <ForecastControls />,
  },
  {
    id: "advanced",
    label: "Advanced",
    icon: <FlaskConical size={15} />,
    content: <AdvancedEntities />,
  },
];

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function ControlDashboard() {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);

  const activeSection = SECTIONS.find((s) => s.id === activeId) ?? SECTIONS[0];

  return (
    <div className="flex min-h-[calc(100vh-120px)]">
      {/* Left sidebar nav */}
      <aside className="w-52 shrink-0 border-r border-muted bg-surface/60 px-2 py-4">
        <nav className="space-y-0.5">
          {SECTIONS.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setActiveId(section.id)}
              className={
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors " +
                (section.id === activeId
                  ? "bg-accent text-white"
                  : "text-text/60 hover:bg-muted/50 hover:text-text")
              }
            >
              <span className="shrink-0 opacity-80">{section.icon}</span>
              {section.label}
            </button>
          ))}
        </nav>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto px-8 py-6">
        <h2 className="mb-6 text-base font-semibold text-text">{activeSection.label}</h2>
        {activeSection.content}
      </main>
    </div>
  );
}
