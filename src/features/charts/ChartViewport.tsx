"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import styles from "./charts.module.css";

export function ChartViewport({ title, children }: { title: string; children: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = viewport.current;
    if (!element) {
      return;
    }
    // Lazy plot loading changes height; resizing changes available width. Both
    // trigger this observer without measuring layout during React rendering.
    const observer = new ResizeObserver(() => {
      setOverflows(element.scrollWidth > element.clientWidth);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      {overflows && <p className={styles.scrollHint}>Scroll horizontally to see the full chart.</p>}
      <div ref={viewport} className={styles.plot} tabIndex={0} role="region" aria-label={`${title} chart`}>
        {children}
      </div>
    </>
  );
}
