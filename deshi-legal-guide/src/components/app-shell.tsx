import { Link } from "@tanstack/react-router";
import { Moon, Scale, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { useLanguage } from "@/components/language-provider";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LANGUAGES, type LanguageCode } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const THEME_KEY = "nyayasahay.theme";

function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_KEY);
    const isDark = stored ? stored === "dark" : false;
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    window.localStorage.setItem(THEME_KEY, next ? "dark" : "light");
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Switch theme">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

export function LanguagePicker({ className }: { className?: string }) {
  const { language, setLanguage } = useLanguage();
  return (
    <Select value={language} onValueChange={(value) => setLanguage(value as LanguageCode)}>
      <SelectTrigger className={cn("h-9 w-[140px]", className)} aria-label="Language">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LANGUAGES.map((entry) => (
          <SelectItem key={entry.code} value={entry.code}>
            {entry.native}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AppShell({
  children,
  fullHeight = false,
}: {
  children: React.ReactNode;
  fullHeight?: boolean;
}) {
  const { t } = useLanguage();

  const items = [
    { to: "/", label: t("nav.home") },
    { to: "/chat", label: t("nav.chat") },
    { to: "/documents", label: t("nav.documents") },
    { to: "/matters", label: t("nav.matters") },
    { to: "/library", label: t("nav.library") },
  ] as const;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Scale className="size-5" />
            </span>
            <span className="hidden font-serif text-lg font-semibold sm:inline">
              {t("app.name")}
            </span>
          </Link>

          <nav className="flex flex-1 items-center gap-0.5 overflow-x-auto">
            {items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === "/" }}
                activeProps={{ className: "bg-accent text-accent-foreground" }}
                className="shrink-0 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex shrink-0 items-center gap-1">
            <LanguagePicker className="hidden sm:flex" />
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className={cn("flex-1", fullHeight && "flex min-h-0 flex-col")}>{children}</main>

      <footer className="border-t border-border bg-muted/40">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <p className="font-medium text-foreground">{t("app.name")}</p>
          <p className="mt-1 max-w-3xl">{t("disclaimer.short")}</p>
        </div>
      </footer>
    </div>
  );
}
