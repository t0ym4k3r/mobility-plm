// ─────────────────────────────────────────────────────────────────────────────
//  MOBILITY PLM — App.jsx
//  Requires: npm install recharts @supabase/supabase-js
//
//  Env vars (create a .env file in project root):
//    VITE_SUPABASE_URL=https://your-project.supabase.co
//    VITE_SUPABASE_ANON_KEY=your-anon-key
//
//  Supabase SQL setup (run once in Supabase SQL editor):
//
//    create table products (
//      id         serial primary key,
//      name       text not null,
//      category   text not null,
//      stage      text not null,
//      asp        numeric default 0,
//      bom        numeric default 0,
//      created_at timestamptz default now()
//    );
//
//    create table vol_data (
//      id          serial primary key,
//      product_id  integer references products(id) on delete cascade,
//      month_index integer not null,
//      forecast    integer default 0,
//      actual      integer,
//      unique(product_id, month_index)
//    );
//
//    -- Allow anonymous reads and writes (adjust to RLS policies for prod)
//    alter table products enable row level security;
//    alter table vol_data  enable row level security;
//    create policy "public read"  on products for select using (true);
//    create policy "public write" on products for all    using (true);
//    create policy "public read"  on vol_data  for select using (true);
//    create policy "public write" on vol_data  for all    using (true);
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ComposedChart, BarChart, Bar,
} from "recharts";

// ── SUPABASE CLIENT ───────────────────────────────────────────────────────────
const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const CATEGORIES = [
  "Kickscooters","EV Rideons","Manual Rideons",
  "Tricycles","Baby Walkers","Balance Bikes",
];
const CATEGORY_COLORS = {
  "Kickscooters":   "#E8FF47",
  "EV Rideons":     "#47FFD4",
  "Manual Rideons": "#FF6B47",
  "Tricycles":      "#B847FF",
  "Baby Walkers":   "#47A3FF",
  "Balance Bikes":  "#FF47A3",
};
const LIFECYCLE_STAGES = ["Development","Launch","Growth","Maturity","Decline","Discontinued"];
const STAGE_COLORS = {
  "Development": "#6B7280",
  "Launch":      "#3B82F6",
  "Growth":      "#10B981",
  "Maturity":    "#F59E0B",
  "Decline":     "#EF4444",
  "Discontinued":"#374151",
};

const TODAY = new Date(2025, 0, 1);
const MONTHS = Array.from({ length: 24 }, (_, i) => {
  const d = new Date(TODAY);
  d.setMonth(d.getMonth() + i);
  return `${d.toLocaleString("default", { month: "short" })} ${d.getFullYear()}`;
});
const CURRENT_MONTH_IDX = 13; // "today" marker

// ── SEED DATA (inserted once if DB is empty) ──────────────────────────────────
const SEED_PRODUCTS = [
  { name:"Spark 100",   category:"Kickscooters",   stage:"Growth",      asp:89,  bom:34  },
  { name:"Spark 200",   category:"Kickscooters",   stage:"Maturity",    asp:129, bom:47  },
  { name:"Blaze Pro",   category:"Kickscooters",   stage:"Launch",      asp:179, bom:62  },
  { name:"Volt Jr",     category:"EV Rideons",     stage:"Growth",      asp:249, bom:98  },
  { name:"Volt Max",    category:"EV Rideons",     stage:"Maturity",    asp:399, bom:148 },
  { name:"Cruiser 3W",  category:"Manual Rideons", stage:"Maturity",    asp:79,  bom:28  },
  { name:"Rally Kids",  category:"Manual Rideons", stage:"Decline",     asp:59,  bom:24  },
  { name:"TriStar",     category:"Tricycles",      stage:"Growth",      asp:109, bom:41  },
  { name:"TriStar Pro", category:"Tricycles",      stage:"Launch",      asp:149, bom:55  },
  { name:"StepStart",   category:"Baby Walkers",   stage:"Maturity",    asp:69,  bom:22  },
  { name:"WalkAway",    category:"Baby Walkers",   stage:"Growth",      asp:89,  bom:28  },
  { name:"Glide Mini",  category:"Balance Bikes",  stage:"Growth",      asp:99,  bom:34  },
  { name:"Glide X",     category:"Balance Bikes",  stage:"Development", asp:139, bom:48  },
];

function genForecast(baseVol, stage) {
  const curve = { Development:0.1, Launch:0.5, Growth:1.2, Maturity:1.0, Decline:0.5, Discontinued:0.1 }[stage] || 1;
  return MONTHS.map((_, i) => {
    const trend = stage === "Growth" ? 1 + i * 0.04 : stage === "Decline" ? 1 - i * 0.03 : 1;
    return Math.round(baseVol * curve * trend * (0.9 + Math.random() * 0.2));
  });
}
function genActuals(forecast, fill = 14) {
  return forecast.map((f, i) => i < fill ? Math.round(f * (0.85 + Math.random() * 0.3)) : null);
}

// ── SUPABASE DATA LAYER ───────────────────────────────────────────────────────

/** Load all products from DB */
async function dbLoadProducts() {
  const { data, error } = await supabase.from("products").select("*").order("id");
  if (error) throw error;
  return data;
}

/** Load all vol_data rows, reshape into { [product_id]: { forecast[], actuals[] } } */
async function dbLoadVolData() {
  const { data, error } = await supabase.from("vol_data").select("*");
  if (error) throw error;
  const map = {};
  data.forEach(row => {
    if (!map[row.product_id]) {
      map[row.product_id] = {
        forecast: Array(24).fill(0),
        actuals:  Array(24).fill(null),
      };
    }
    map[row.product_id].forecast[row.month_index] = row.forecast ?? 0;
    map[row.product_id].actuals[row.month_index]  = row.actual  ?? null;
  });
  return map;
}

/** Insert a new product, return the inserted row (with id) */
async function dbInsertProduct(prod) {
  const { data, error } = await supabase
    .from("products")
    .insert([{ name: prod.name, category: prod.category, stage: prod.stage, asp: prod.asp, bom: prod.bom }])
    .select()
    .single();
  if (error) throw error;
  return data;
}

/** Update product fields (asp, bom, stage, etc.) */
async function dbUpdateProduct(id, fields) {
  const { error } = await supabase.from("products").update(fields).eq("id", id);
  if (error) throw error;
}

/** Upsert a single vol_data cell */
async function dbUpsertVolCell(productId, monthIndex, forecast, actual) {
  const row = { product_id: productId, month_index: monthIndex, forecast, actual };
  const { error } = await supabase.from("vol_data").upsert([row], { onConflict: "product_id,month_index" });
  if (error) throw error;
}

/** Upsert many vol_data cells at once (used for bulk CSV uploads) */
async function dbUpsertVolBatch(rows) {
  // rows: [{ product_id, month_index, forecast?, actual? }]
  const { error } = await supabase.from("vol_data").upsert(rows, { onConflict: "product_id,month_index" });
  if (error) throw error;
}

/** Delete all products (reset) */
async function dbDeleteAllProducts() {
  const { error } = await supabase.from("products").delete().gte("id", 0);
  if (error) throw error;
}

/** Seed DB with sample data */
async function dbSeed() {
  for (const p of SEED_PRODUCTS) {
    const inserted = await dbInsertProduct(p);
    const base = 200 + Math.floor(Math.random() * 800);
    const forecast = genForecast(base, p.stage);
    const actuals  = genActuals(forecast);
    const volRows  = MONTHS.map((_, mi) => ({
      product_id:  inserted.id,
      month_index: mi,
      forecast:    forecast[mi],
      actual:      actuals[mi] ?? null,
    }));
    await dbUpsertVolBatch(volRows);
  }
}

// ── CSV PARSER ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return null;
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(",").map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => (obj[h] = vals[i]));
    return obj;
  });
}

// ── ICONS ─────────────────────────────────────────────────────────────────────
const Icon = {
  Upload:      () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>),
  ChevronDown: () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>),
  X:           () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>),
  Plus:        () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>),
  Save:        () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>),
  Trash:       () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>),
  Refresh:     () => (<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>),
};

// ── STYLE HELPERS ─────────────────────────────────────────────────────────────
const btnReset = { background:"none", border:"none", cursor:"pointer", outline:"none", display:"flex", alignItems:"center", gap:6, fontFamily:"inherit" };
const btnStyle = (bg, color) => ({
  ...btnReset, padding:"8px 16px", borderRadius:7, fontSize:13, fontWeight:600,
  background:bg, color, border:`1px solid ${bg==="transparent"?"#2A2A2A":bg}`,
  cursor:"pointer", display:"inline-flex", alignItems:"center", gap:6,
  transition:"opacity 0.15s", whiteSpace:"nowrap",
});
const thStyle = {
  padding:"10px 14px", textAlign:"left", fontSize:10, color:"#555",
  textTransform:"uppercase", letterSpacing:1.5,
  fontFamily:"'Space Mono',monospace", fontWeight:400, whiteSpace:"nowrap",
};
const inputStyle = {
  width:"100%", background:"#111", border:"1px solid #2A2A2A", borderRadius:7,
  padding:"9px 12px", fontSize:13, color:"#FFF", fontFamily:"inherit", outline:"none",
};

// ── SMALL REUSABLE COMPONENTS ─────────────────────────────────────────────────
const SelectBox = ({ value, onChange, options, accent }) => (
  <div style={{ position:"relative" }}>
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ ...inputStyle, paddingRight:28, paddingLeft:12, fontSize:12, cursor:"pointer",
        border:`1px solid ${value !== options[0]?.v ? accent+"44" : "#222"}`,
        color: value !== options[0]?.v ? accent : "#888",
        background:"#0D0D0D", width:"auto" }}>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
    <div style={{ position:"absolute", right:8, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"#555" }}>
      <Icon.ChevronDown />
    </div>
  </div>
);

const FormField = ({ label, children }) => (
  <div>
    <label style={{ display:"block", fontSize:11, color:"#555", textTransform:"uppercase",
      letterSpacing:1.5, marginBottom:7, fontFamily:"'Space Mono',monospace" }}>{label}</label>
    {children}
  </div>
);

const SectionLabel = ({ label, sub }) => (
  <div style={{ marginBottom:4 }}>
    <div style={{ fontSize:14, fontWeight:600, color:"#DDD" }}>{label}</div>
    <div style={{ fontSize:12, color:"#555", marginTop:2 }}>{sub}</div>
  </div>
);

const CustomTooltip = ({ active, payload, label, unit="" }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:"#0D0D0D", border:"1px solid #2A2A2A", borderRadius:6, padding:"10px 14px", fontSize:12 }}>
      <div style={{ color:"#888", marginBottom:6, fontFamily:"'Space Mono',monospace" }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:8, marginBottom:3 }}>
          <div style={{ width:8, height:8, borderRadius:2, background:p.color }} />
          <span style={{ color:"#AAA" }}>{p.name}:</span>
          <span style={{ color:"#FFF", fontWeight:600 }}>
            {unit==="$" ? "$" : ""}{typeof p.value==="number" ? p.value.toLocaleString() : "-"}{unit==="vol" ? " units" : ""}
          </span>
        </div>
      ))}
    </div>
  );
};

const SaveIndicator = ({ status }) => {
  const map = {
    idle:   { color:"#444",    label:"Synced with database" },
    saving: { color:"#F59E0B", label:"Saving…" },
    saved:  { color:"#10B981", label:"Saved" },
    error:  { color:"#EF4444", label:"Save error — check connection" },
  };
  const s = map[status] || map.idle;
  return (
    <div style={{ display:"flex", alignItems:"center", gap:6, fontSize:11, color:s.color, fontFamily:"'Space Mono',monospace" }}>
      <div style={{ width:6, height:6, borderRadius:"50%", background:s.color,
        animation: status==="saving" ? "pulse 1s infinite" : "none" }} />
      {s.label}
    </div>
  );
};

// ══════════════════════════════════════════════════════════════════════════════
//  MAIN APP
// ══════════════════════════════════════════════════════════════════════════════
export default function App() {
  // ── State ──────────────────────────────────────────────────────────────────
  const [loadState,     setLoadState]     = useState("loading"); // loading | ready | error
  const [loadError,     setLoadError]     = useState(null);
  const [saveStatus,    setSaveStatus]    = useState("idle");
  const [products,      setProducts]      = useState([]);
  const [volData,       setVolData]       = useState({}); // { [productId]: { forecast[], actuals[] } }
  const [activeTab,     setActiveTab]     = useState("dashboard");
  const [toast,         setToast]         = useState(null);
  const [modal,         setModal]         = useState(null);
  const [confirmReset,  setConfirmReset]  = useState(false);

  // Dashboard filter state
  const [viewMode,       setViewMode]       = useState("volume");
  const [groupBy,        setGroupBy]        = useState("model");
  const [filterCat,      setFilterCat]      = useState("All");
  const [filterStage,    setFilterStage]    = useState("All");
  const [selectedModels, setSelectedModels] = useState(new Set());

  // Add product form
  const [newProd, setNewProd] = useState({
    name:"", category:CATEGORIES[0], stage:"Development", asp:0, bom:0,
  });

  const saveTimer = useRef(null);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const showToast = (msg, type="success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const setSaving = () => {
    clearTimeout(saveTimer.current);
    setSaveStatus("saving");
  };
  const setSaved = () => {
    saveTimer.current = setTimeout(() => setSaveStatus("idle"), 2500);
    setSaveStatus("saved");
  };
  const setSaveError = (err) => {
    console.error("Save error:", err);
    setSaveStatus("error");
    showToast("Database error: " + (err?.message || "unknown"), "error");
  };

  // ── Load on mount ──────────────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        let prods = await dbLoadProducts();

        // If DB is empty, seed it with sample data
        if (!prods.length) {
          showToast("First run — seeding sample catalogue…");
          await dbSeed();
          prods = await dbLoadProducts();
          showToast(`Seeded ${prods.length} sample models`);
        } else {
          showToast(`Loaded ${prods.length} models from database`);
        }

        const vd = await dbLoadVolData();
        setProducts(prods);
        setVolData(vd);
        setSelectedModels(new Set(prods.map(p => p.id)));
        setLoadState("ready");
      } catch (err) {
        console.error("Load error:", err);
        setLoadError(err?.message || "Failed to connect to database.");
        setLoadState("error");
      }
    })();
  }, []);

  // ── Add product ────────────────────────────────────────────────────────────
  const addProduct = async () => {
    if (!newProd.name.trim()) return;
    setSaving();
    try {
      const inserted = await dbInsertProduct({
        ...newProd,
        asp: parseFloat(newProd.asp) || 0,
        bom: parseFloat(newProd.bom) || 0,
      });

      // Generate and save vol data for the new product
      const base     = 100 + Math.floor(Math.random() * 300);
      const forecast = genForecast(base, newProd.stage);
      const volRows  = MONTHS.map((_, mi) => ({
        product_id:  inserted.id,
        month_index: mi,
        forecast:    forecast[mi],
        actual:      null,
      }));
      await dbUpsertVolBatch(volRows);

      // Update local state
      setProducts(prev => [...prev, inserted]);
      setVolData(prev => ({
        ...prev,
        [inserted.id]: { forecast, actuals: Array(24).fill(null) },
      }));
      setSelectedModels(prev => new Set([...prev, inserted.id]));
      setNewProd({ name:"", category:CATEGORIES[0], stage:"Development", asp:0, bom:0 });
      setModal(null);
      setSaved();
      showToast(`${inserted.name} added`);
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── Update product (stage / asp / bom inline edit) ─────────────────────────
  const updateProduct = async (id, fields) => {
    setSaving();
    try {
      await dbUpdateProduct(id, fields);
      setProducts(prev => prev.map(p => p.id === id ? { ...p, ...fields } : p));
      setSaved();
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── CSV Upload: Forecast ───────────────────────────────────────────────────
  const handleForecastUpload = async (text) => {
    const rows = parseCSV(text);
    if (!rows) { showToast("Invalid CSV format", "error"); return; }
    setSaving();
    try {
      const dbRows = [];
      const localUpdates = {}; // { productId: { [mi]: forecast } }

      rows.forEach(r => {
        const prod = products.find(p => p.name === r.model || p.id === parseInt(r.id));
        if (!prod) return;
        const mi = MONTHS.indexOf(r.month);
        if (mi < 0) return;
        const fVal = parseInt(r.volume) || 0;
        // Keep existing actual for this cell
        const existingActual = volData[prod.id]?.actuals[mi] ?? null;
        dbRows.push({ product_id: prod.id, month_index: mi, forecast: fVal, actual: existingActual });
        if (!localUpdates[prod.id]) localUpdates[prod.id] = {};
        localUpdates[prod.id][mi] = fVal;
      });

      if (!dbRows.length) { showToast("No matching models found in CSV", "error"); return; }
      await dbUpsertVolBatch(dbRows);

      // Apply local state updates
      setVolData(prev => {
        const vd = { ...prev };
        Object.entries(localUpdates).forEach(([pid, changes]) => {
          const pidNum = parseInt(pid);
          vd[pidNum] = {
            forecast: [...(vd[pidNum]?.forecast || Array(24).fill(0))],
            actuals:  [...(vd[pidNum]?.actuals  || Array(24).fill(null))],
          };
          Object.entries(changes).forEach(([mi, val]) => {
            vd[pidNum].forecast[parseInt(mi)] = val;
          });
        });
        return vd;
      });

      setSaved();
      showToast(`Updated ${dbRows.length} forecast entries`);
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── CSV Upload: Actuals ────────────────────────────────────────────────────
  const handleActualsUpload = async (text) => {
    const rows = parseCSV(text);
    if (!rows) { showToast("Invalid CSV format", "error"); return; }
    setSaving();
    try {
      const dbRows = [];
      const localUpdates = {};

      rows.forEach(r => {
        const prod = products.find(p => p.name === r.model || p.id === parseInt(r.id));
        if (!prod) return;
        const mi = MONTHS.indexOf(r.month);
        if (mi < 0) return;
        const aVal = parseInt(r.volume) || 0;
        const existingForecast = volData[prod.id]?.forecast[mi] ?? 0;
        dbRows.push({ product_id: prod.id, month_index: mi, forecast: existingForecast, actual: aVal });
        if (!localUpdates[prod.id]) localUpdates[prod.id] = {};
        localUpdates[prod.id][mi] = aVal;
      });

      if (!dbRows.length) { showToast("No matching models found in CSV", "error"); return; }
      await dbUpsertVolBatch(dbRows);

      setVolData(prev => {
        const vd = { ...prev };
        Object.entries(localUpdates).forEach(([pid, changes]) => {
          const pidNum = parseInt(pid);
          vd[pidNum] = {
            forecast: [...(vd[pidNum]?.forecast || Array(24).fill(0))],
            actuals:  [...(vd[pidNum]?.actuals  || Array(24).fill(null))],
          };
          Object.entries(changes).forEach(([mi, val]) => {
            vd[pidNum].actuals[parseInt(mi)] = val;
          });
        });
        return vd;
      });

      setSaved();
      showToast(`Updated ${dbRows.length} actual entries`);
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── CSV Upload: Costs ──────────────────────────────────────────────────────
  const handleCostUpload = async (text) => {
    const rows = parseCSV(text);
    if (!rows) { showToast("Invalid CSV format", "error"); return; }
    setSaving();
    try {
      let n = 0;
      for (const r of rows) {
        const prod = products.find(p => p.name === r.model || p.id === parseInt(r.id));
        if (!prod) continue;
        const fields = {};
        if (r.asp) fields.asp = parseFloat(r.asp);
        if (r.bom) fields.bom = parseFloat(r.bom);
        if (!Object.keys(fields).length) continue;
        await dbUpdateProduct(prod.id, fields);
        setProducts(prev => prev.map(p => p.id === prod.id ? { ...p, ...fields } : p));
        n++;
      }
      setSaved();
      showToast(`Updated costs for ${n} models`);
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── Reset ──────────────────────────────────────────────────────────────────
  const handleReset = async () => {
    setSaving();
    try {
      await dbDeleteAllProducts(); // cascade deletes vol_data too
      await dbSeed();
      const prods = await dbLoadProducts();
      const vd    = await dbLoadVolData();
      setProducts(prods);
      setVolData(vd);
      setSelectedModels(new Set(prods.map(p => p.id)));
      setConfirmReset(false);
      setSaved();
      showToast("Data reset to sample catalogue");
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── Refresh from DB ────────────────────────────────────────────────────────
  const handleRefresh = async () => {
    setSaving();
    try {
      const prods = await dbLoadProducts();
      const vd    = await dbLoadVolData();
      setProducts(prods);
      setVolData(vd);
      setSelectedModels(new Set(prods.map(p => p.id)));
      setSaved();
      showToast("Refreshed from database");
    } catch (err) {
      setSaveError(err);
    }
  };

  // ── CSV Template download ──────────────────────────────────────────────────
  const downloadTemplate = (type) => {
    let content = "";
    if (type === "forecast" || type === "actuals") {
      content = "model,month,volume\n";
      products.slice(0, 3).forEach(p => { content += `${p.name},${MONTHS[0]},500\n`; });
    } else {
      content = "model,asp,bom\n";
      products.slice(0, 3).forEach(p => { content += `${p.name},${p.asp},${p.bom}\n`; });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type:"text/csv" }));
    a.download = `template_${type}.csv`;
    a.click();
  };

  // ── Computed / memoised ────────────────────────────────────────────────────
  const filteredProducts = useMemo(() =>
    products.filter(p =>
      (filterCat   === "All" || p.category === filterCat) &&
      (filterStage === "All" || p.stage    === filterStage) &&
      selectedModels.has(p.id)
    ),
    [products, filterCat, filterStage, selectedModels]
  );

  const chartData = useMemo(() => {
    if (groupBy === "model") {
      return MONTHS.map((month, mi) => {
        const row = { month };
        filteredProducts.forEach(p => {
          const fd = volData[p.id]; if (!fd) return;
          const fVol = fd.forecast[mi] || 0, aVol = fd.actuals[mi];
          if (viewMode === "volume") {
            row[`${p.name}_F`] = fVol;
            if (aVol != null) row[`${p.name}_A`] = aVol;
          } else if (viewMode === "value") {
            row[`${p.name}_F`] = Math.round(fVol * p.asp / 1000);
            if (aVol != null) row[`${p.name}_A`] = Math.round(aVol * p.asp / 1000);
          } else {
            const m = p.asp > 0 ? (p.asp - p.bom) / p.asp : 0;
            row[`${p.name}_F`] = Math.round(fVol * p.asp * m / 1000);
            if (aVol != null) row[`${p.name}_A`] = Math.round(aVol * p.asp * m / 1000);
          }
        });
        return row;
      });
    } else {
      return MONTHS.map((month, mi) => {
        const row = { month };
        CATEGORIES.forEach(cat => {
          const catProds = filteredProducts.filter(p => p.category === cat);
          if (!catProds.length) return;
          let fTot = 0, aTot = 0, aHas = false;
          catProds.forEach(p => {
            const fd = volData[p.id]; if (!fd) return;
            const fVol = fd.forecast[mi] || 0, aVol = fd.actuals[mi];
            if (viewMode === "volume") { fTot += fVol; if (aVol != null) { aTot += aVol; aHas = true; } }
            else if (viewMode === "value") { fTot += Math.round(fVol * p.asp / 1000); if (aVol != null) { aTot += Math.round(aVol * p.asp / 1000); aHas = true; } }
            else { const m = p.asp > 0 ? (p.asp - p.bom) / p.asp : 0; fTot += Math.round(fVol * p.asp * m / 1000); if (aVol != null) { aTot += Math.round(aVol * p.asp * m / 1000); aHas = true; } }
          });
          row[`${cat}_F`] = fTot;
          if (aHas) row[`${cat}_A`] = aTot;
        });
        return row;
      });
    }
  }, [filteredProducts, volData, viewMode, groupBy]);

  const kpis = useMemo(() => {
    let fVol = 0, aVol = 0, fRev = 0, fMar = 0;
    filteredProducts.forEach(p => {
      const fd = volData[p.id]; if (!fd) return;
      fd.forecast.forEach((v, i) => {
        if (i <= CURRENT_MONTH_IDX) { fVol += v; fRev += v * p.asp; fMar += v * p.asp * ((p.asp - p.bom) / p.asp); }
      });
      fd.actuals.forEach(v => { if (v != null) aVol += v; });
    });
    const attain   = fVol > 0 ? Math.round(aVol / fVol * 100) : 0;
    const avgMargin = fRev > 0 ? Math.round(fMar / fRev * 100) : 0;
    return [
      { label:"Active Models",       value: filteredProducts.filter(p => !["Discontinued","Development"].includes(p.stage)).length },
      { label:"Forecast Attainment", value:`${attain}%`, delta: attain >= 100 ? "on track" : "below" },
      { label:"Total Forecast Rev",  value:`$${(fRev / 1e6).toFixed(1)}M` },
      { label:"Avg Gross Margin",    value: fRev > 0 ? `${avgMargin}%` : "—" },
    ];
  }, [filteredProducts, volData]);

  const chartKeys = useMemo(() =>
    groupBy === "model"
      ? filteredProducts.flatMap(p => [`${p.name}_F`, `${p.name}_A`])
      : CATEGORIES.flatMap(c => [`${c}_F`, `${c}_A`]),
    [filteredProducts, groupBy]
  );

  const getLineColor = (key) => {
    if (groupBy === "category") return CATEGORY_COLORS[key.replace(/_[FA]$/, "")] || "#888";
    const p = products.find(p => p.name === key.replace(/_[FA]$/, ""));
    return p ? CATEGORY_COLORS[p.category] || "#888" : "#888";
  };

  // ── File drop zone component ───────────────────────────────────────────────
  const FileDropZone = ({ label, onUpload, templateType, accent="#47FFD4" }) => {
    const ref = useRef();
    const handle = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = ev => onUpload(ev.target.result);
      r.readAsText(f);
      e.target.value = "";
    };
    return (
      <div style={{ border:"1px dashed #333", borderRadius:8, padding:"20px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, background:"#0A0A0A" }}>
        <div>
          <div style={{ color:"#DDD", fontSize:13, fontWeight:600, marginBottom:4 }}>{label}</div>
          <div style={{ color:"#555", fontSize:12 }}>
            CSV: model, month, volume &nbsp;·&nbsp;
            <span style={{ color:"#47A3FF", cursor:"pointer", textDecoration:"underline" }} onClick={() => downloadTemplate(templateType)}>
              download template
            </span>
          </div>
        </div>
        <input type="file" accept=".csv" ref={ref} style={{ display:"none" }} onChange={handle} />
        <button onClick={() => ref.current.click()} style={btnStyle("#1A1A1A", accent)}>
          <Icon.Upload /> Upload CSV
        </button>
      </div>
    );
  };

  const FileDropZoneCost = () => {
    const ref = useRef();
    const handle = (e) => {
      const f = e.target.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = ev => handleCostUpload(ev.target.result);
      r.readAsText(f);
      e.target.value = "";
    };
    return (
      <div style={{ border:"1px dashed #333", borderRadius:8, padding:"20px 24px", display:"flex", alignItems:"center", justifyContent:"space-between", gap:16, background:"#0A0A0A" }}>
        <div>
          <div style={{ color:"#DDD", fontSize:13, fontWeight:600, marginBottom:4 }}>ASP & BoM Costs</div>
          <div style={{ color:"#555", fontSize:12 }}>
            CSV: model, asp, bom &nbsp;·&nbsp;
            <span style={{ color:"#47A3FF", cursor:"pointer", textDecoration:"underline" }} onClick={() => downloadTemplate("costs")}>
              download template
            </span>
          </div>
        </div>
        <input type="file" accept=".csv" ref={ref} style={{ display:"none" }} onChange={handle} />
        <button onClick={() => ref.current.click()} style={btnStyle("#1A1A1A", "#FF6B47")}>
          <Icon.Upload /> Upload CSV
        </button>
      </div>
    );
  };

  // ── Loading screen ─────────────────────────────────────────────────────────
  if (loadState === "loading") return (
    <div style={{ minHeight:"100vh", background:"#080808", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:20 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg) } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
      `}</style>
      <div style={{ width:40, height:40, border:"2px solid #1E1E1E", borderTop:"2px solid #E8FF47", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
      <div style={{ fontFamily:"'Space Mono',monospace", fontSize:12, color:"#555", letterSpacing:3 }}>CONNECTING TO DATABASE…</div>
    </div>
  );

  // ── Error screen ───────────────────────────────────────────────────────────
  if (loadState === "error") return (
    <div style={{ minHeight:"100vh", background:"#080808", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, padding:32 }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap');`}</style>
      <div style={{ fontSize:28 }}>⚠️</div>
      <div style={{ fontFamily:"'Space Mono',monospace", fontSize:14, color:"#EF4444" }}>DATABASE CONNECTION FAILED</div>
      <div style={{ fontSize:13, color:"#555", maxWidth:400, textAlign:"center", lineHeight:1.7 }}>
        {loadError}<br/><br/>
        Check that your <code style={{ color:"#47FFD4" }}>VITE_SUPABASE_URL</code> and <code style={{ color:"#47FFD4" }}>VITE_SUPABASE_ANON_KEY</code> environment variables are set correctly, and that your Supabase tables exist.
      </div>
      <button onClick={() => window.location.reload()} style={btnStyle("#E8FF47", "#080808")}><Icon.Refresh /> Retry</button>
    </div>
  );

  // ── Main UI ────────────────────────────────────────────────────────────────
  return (
    <div style={{ minHeight:"100vh", background:"#080808", color:"#E8E8E8", fontFamily:"'DM Sans',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');
        * { box-sizing:border-box; margin:0; padding:0 }
        ::-webkit-scrollbar { width:6px; height:6px }
        ::-webkit-scrollbar-track { background:#111 }
        ::-webkit-scrollbar-thumb { background:#333; border-radius:3px }
        select { appearance:none }
        input::placeholder { color:#444 }
        .tab-btn:hover  { background:#1A1A1A !important }
        .row-hover:hover { background:#141414 !important }
        @keyframes spin  { to { transform:rotate(360deg) } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      `}</style>

      {/* ── HEADER ── */}
      <header style={{ borderBottom:"1px solid #1E1E1E", padding:"0 32px", display:"flex", alignItems:"center", justifyContent:"space-between", height:60, background:"#0D0D0D", position:"sticky", top:0, zIndex:100 }}>
        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <div style={{ width:32, height:32, background:"linear-gradient(135deg,#E8FF47,#47FFD4)", borderRadius:6, display:"flex", alignItems:"center", justifyContent:"center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#080808" strokeWidth="2.5">
              <circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
          </div>
          <div>
            <div style={{ fontFamily:"'Space Mono',monospace", fontSize:13, fontWeight:700, letterSpacing:1, color:"#FFF" }}>MOBILITY PLM</div>
            <div style={{ fontSize:10, color:"#555", letterSpacing:2, textTransform:"uppercase" }}>Product Lifecycle Manager</div>
          </div>
        </div>

        <nav style={{ display:"flex", gap:4 }}>
          {["dashboard","products","data","upload"].map(tab => (
            <button key={tab} className="tab-btn" onClick={() => setActiveTab(tab)}
              style={{ ...btnReset, padding:"8px 16px", borderRadius:6, fontSize:13, fontWeight:500, textTransform:"capitalize",
                background: activeTab===tab ? "#1E1E1E" : "transparent",
                color: activeTab===tab ? "#FFF" : "#666",
                border: activeTab===tab ? "1px solid #2A2A2A" : "1px solid transparent",
                transition:"all 0.15s" }}>
              {tab}
            </button>
          ))}
        </nav>

        <div style={{ display:"flex", alignItems:"center", gap:16 }}>
          <SaveIndicator status={saveStatus} />
          <button onClick={handleRefresh} style={{ ...btnReset, fontSize:11, color:"#555", cursor:"pointer", gap:5 }} title="Refresh from DB">
            <Icon.Refresh />
          </button>
          <button onClick={() => setConfirmReset(true)} style={{ ...btnReset, fontSize:11, color:"#444", cursor:"pointer", gap:5 }}>
            <Icon.Trash /> Reset
          </button>
        </div>
      </header>

      <main style={{ padding:"28px 32px", maxWidth:1400, margin:"0 auto" }}>

        {/* ──────────── DASHBOARD ──────────── */}
        {activeTab === "dashboard" && <>
          {/* KPI cards */}
          <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:16, marginBottom:28 }}>
            {kpis.map((k, i) => (
              <div key={i} style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:10, padding:"20px 22px", animation:`fadeUp 0.3s ease both`, animationDelay:`${i*60}ms` }}>
                <div style={{ fontSize:11, color:"#555", textTransform:"uppercase", letterSpacing:2, marginBottom:10, fontFamily:"'Space Mono',monospace" }}>{k.label}</div>
                <div style={{ fontSize:28, fontWeight:700, color:"#FFF", fontFamily:"'Space Mono',monospace" }}>{k.value}</div>
                {k.delta && <div style={{ fontSize:11, marginTop:6, color: k.delta==="on track" ? "#10B981" : "#F59E0B" }}>{k.delta==="on track" ? "✓ On track" : "⚠ Below forecast"}</div>}
              </div>
            ))}
          </div>

          {/* Filters */}
          <div style={{ display:"flex", gap:12, marginBottom:20, flexWrap:"wrap", alignItems:"center" }}>
            <SelectBox value={viewMode} onChange={setViewMode} accent="#E8FF47" options={[
              {v:"volume",l:"Volume (Units)"},{v:"value",l:"Revenue ($K)"},{v:"margin",l:"Gross Profit ($K)"}
            ]}/>
            <SelectBox value={groupBy} onChange={setGroupBy} accent="#47FFD4" options={[
              {v:"model",l:"By Model"},{v:"category",l:"By Category"}
            ]}/>
            <SelectBox value={filterCat} onChange={setFilterCat} accent="#47A3FF" options={[
              {v:"All",l:"All Categories"}, ...CATEGORIES.map(c=>({v:c,l:c}))
            ]}/>
            <SelectBox value={filterStage} onChange={setFilterStage} accent="#FF6B47" options={[
              {v:"All",l:"All Stages"}, ...LIFECYCLE_STAGES.map(s=>({v:s,l:s}))
            ]}/>
            <div style={{ marginLeft:"auto", fontSize:12, color:"#555" }}>{filteredProducts.length} models</div>
          </div>

          {/* Main chart */}
          <div style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:12, padding:"24px", marginBottom:24 }}>
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:14, fontWeight:600, color:"#FFF" }}>
                {viewMode==="volume" ? "Volume — Forecast vs Actuals" : viewMode==="value" ? "Revenue ($K) — Forecast vs Actuals" : "Gross Profit ($K) — Forecast vs Actuals"}
              </div>
              <div style={{ fontSize:12, color:"#555", marginTop:3 }}>Solid = Forecast · Dashed = Actuals · 24-month view</div>
            </div>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={chartData} margin={{ top:4, right:16, bottom:4, left:0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" vertical={false}/>
                <XAxis dataKey="month" tick={{ fill:"#555", fontSize:10, fontFamily:"Space Mono" }} tickLine={false} axisLine={{ stroke:"#1E1E1E" }} interval={2}/>
                <YAxis tick={{ fill:"#555", fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={v => v>=1000 ? `${(v/1000).toFixed(0)}K` : v}/>
                <Tooltip content={<CustomTooltip unit={viewMode==="volume"?"vol":"$"}/>}/>
                <ReferenceLine x={MONTHS[CURRENT_MONTH_IDX]} stroke="#333" strokeDasharray="4 4" label={{ value:"Today", fill:"#555", fontSize:10, fontFamily:"Space Mono" }}/>
                {chartKeys.map(key => {
                  const isActual = key.endsWith("_A");
                  return (
                    <Line key={key} type="monotone" dataKey={key} stroke={getLineColor(key)}
                      strokeWidth={isActual?2:1.5} strokeDasharray={isActual?"0":"4 3"}
                      dot={false} connectNulls={false} opacity={isActual?1:0.65}
                      name={key.replace(/_[FA]$/,"")} legendType="none"/>
                  );
                })}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Bottom row */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16 }}>
            <div style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:12, padding:"22px" }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#FFF", marginBottom:4 }}>Category Mix — Forecast Volume</div>
              <div style={{ fontSize:11, color:"#555", marginBottom:16 }}>Next 12 months cumulative</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={CATEGORIES.map(cat => {
                  const vol = filteredProducts.filter(p => p.category===cat).reduce((s,p) => {
                    const fd = volData[p.id]; return fd ? s + fd.forecast.slice(0,12).reduce((a,b)=>a+b,0) : s;
                  },0);
                  return { cat: cat.split(" ")[0], vol };
                })} margin={{ top:4, right:8, bottom:4, left:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1A1A1A" vertical={false}/>
                  <XAxis dataKey="cat" tick={{ fill:"#555", fontSize:10 }} tickLine={false} axisLine={false}/>
                  <YAxis tick={{ fill:"#555", fontSize:10 }} tickLine={false} axisLine={false} tickFormatter={v=>v>=1000?`${(v/1000).toFixed(0)}K`:v}/>
                  <Tooltip content={<CustomTooltip unit="vol"/>}/>
                  <Bar dataKey="vol" name="Volume" radius={[4,4,0,0]} fill="#E8FF47"/>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:12, padding:"22px" }}>
              <div style={{ fontSize:13, fontWeight:600, color:"#FFF", marginBottom:4 }}>Margin by Model</div>
              <div style={{ fontSize:11, color:"#555", marginBottom:16 }}>Gross margin % — current pricing</div>
              <div style={{ overflowY:"auto", maxHeight:200 }}>
                {[...filteredProducts].sort((a,b)=>{
                  const ma = a.asp>0?(a.asp-a.bom)/a.asp*100:0, mb = b.asp>0?(b.asp-b.bom)/b.asp*100:0;
                  return mb-ma;
                }).map(p => {
                  const mg = p.asp>0 ? Math.round((p.asp-p.bom)/p.asp*100) : 0;
                  return (
                    <div key={p.id} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8 }}>
                      <div style={{ width:90, fontSize:11, color:"#AAA", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{p.name}</div>
                      <div style={{ flex:1, height:6, background:"#1A1A1A", borderRadius:3, overflow:"hidden" }}>
                        <div style={{ width:`${Math.min(mg,100)}%`, height:"100%", background:CATEGORY_COLORS[p.category], borderRadius:3, transition:"width 0.6s" }}/>
                      </div>
                      <div style={{ width:36, fontSize:11, color:"#DDD", textAlign:"right", fontFamily:"'Space Mono',monospace" }}>{mg}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </>}

        {/* ──────────── PRODUCTS ──────────── */}
        {activeTab === "products" && <>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:24 }}>
            <div>
              <div style={{ fontSize:20, fontWeight:700, color:"#FFF" }}>Product Catalogue</div>
              <div style={{ fontSize:13, color:"#555", marginTop:2 }}>{products.length} models · synced to Supabase</div>
            </div>
            <button onClick={() => setModal("addProduct")} style={btnStyle("#E8FF47","#080808")}><Icon.Plus/> Add Model</button>
          </div>

          <div style={{ display:"flex", gap:10, marginBottom:24, flexWrap:"wrap" }}>
            {LIFECYCLE_STAGES.map(stage => {
              const count = products.filter(p=>p.stage===stage).length;
              return (
                <div key={stage} style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:8, padding:"12px 18px", display:"flex", gap:10, alignItems:"center" }}>
                  <div style={{ width:8, height:8, borderRadius:2, background:STAGE_COLORS[stage] }}/>
                  <span style={{ fontSize:12, color:"#888" }}>{stage}</span>
                  <span style={{ fontSize:14, fontWeight:700, color:"#FFF", fontFamily:"'Space Mono',monospace" }}>{count}</span>
                </div>
              );
            })}
          </div>

          {CATEGORIES.map(cat => {
            const catProds = products.filter(p=>p.category===cat); if(!catProds.length) return null;
            return (
              <div key={cat} style={{ marginBottom:24 }}>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
                  <div style={{ width:10, height:10, borderRadius:2, background:CATEGORY_COLORS[cat] }}/>
                  <div style={{ fontSize:13, fontWeight:600, color:CATEGORY_COLORS[cat], textTransform:"uppercase", letterSpacing:2, fontFamily:"'Space Mono',monospace" }}>{cat}</div>
                  <div style={{ flex:1, height:1, background:"#1A1A1A" }}/>
                  <div style={{ fontSize:11, color:"#555" }}>{catProds.length} models</div>
                </div>
                <div style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:10, overflow:"hidden" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse" }}>
                    <thead>
                      <tr style={{ borderBottom:"1px solid #1A1A1A" }}>
                        {["Model","Stage","ASP","BoM","Margin","F 12mo","Actuals YTD","Show"].map(h => (
                          <th key={h} style={thStyle}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {catProds.map(p => {
                        const fd   = volData[p.id];
                        const f12  = fd ? fd.forecast.slice(0,12).reduce((a,b)=>a+b,0) : 0;
                        const aYTD = fd ? fd.actuals.filter(v=>v!=null).reduce((a,b)=>a+b,0) : 0;
                        const mg   = p.asp>0 ? Math.round((p.asp-p.bom)/p.asp*100) : 0;
                        const sel  = selectedModels.has(p.id);
                        return (
                          <tr key={p.id} className="row-hover" style={{ borderBottom:"1px solid #131313", transition:"background 0.1s" }}>
                            <td style={{ padding:"11px 14px", fontSize:13, fontWeight:600, color:"#FFF" }}>{p.name}</td>
                            <td style={{ padding:"11px 14px" }}>
                              {/* Clickable stage badge — cycles through stages and saves */}
                              <button onClick={async()=>{
                                const idx=(LIFECYCLE_STAGES.indexOf(p.stage)+1)%LIFECYCLE_STAGES.length;
                                await updateProduct(p.id,{stage:LIFECYCLE_STAGES[idx]});
                              }} title="Click to advance stage" style={{ ...btnReset,
                                background:`${STAGE_COLORS[p.stage]}22`, color:STAGE_COLORS[p.stage],
                                padding:"3px 9px", borderRadius:4, fontSize:11, fontWeight:600,
                                border:`1px solid ${STAGE_COLORS[p.stage]}44`, cursor:"pointer" }}>
                                {p.stage}
                              </button>
                            </td>
                            <td style={{ padding:"11px 14px", fontSize:12, color:"#CCC", fontFamily:"'Space Mono',monospace" }}>${p.asp}</td>
                            <td style={{ padding:"11px 14px", fontSize:12, color:"#CCC", fontFamily:"'Space Mono',monospace" }}>${p.bom}</td>
                            <td style={{ padding:"11px 14px" }}>
                              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                                <div style={{ width:48, height:4, background:"#1A1A1A", borderRadius:2, overflow:"hidden" }}>
                                  <div style={{ width:`${Math.min(mg,100)}%`, height:"100%", background:mg>50?"#10B981":mg>30?"#F59E0B":"#EF4444", borderRadius:2 }}/>
                                </div>
                                <span style={{ fontSize:11, color:"#DDD", fontFamily:"'Space Mono',monospace" }}>{mg}%</span>
                              </div>
                            </td>
                            <td style={{ padding:"11px 14px", fontSize:12, color:"#AAA", fontFamily:"'Space Mono',monospace" }}>{f12.toLocaleString()}</td>
                            <td style={{ padding:"11px 14px", fontSize:12, color:"#AAA", fontFamily:"'Space Mono',monospace" }}>{aYTD.toLocaleString()}</td>
                            <td style={{ padding:"11px 14px" }}>
                              <button onClick={() => setSelectedModels(prev => { const s=new Set(prev); s.has(p.id)?s.delete(p.id):s.add(p.id); return s; })}
                                style={{ ...btnReset, width:22, height:22, borderRadius:4,
                                  background:sel?"#E8FF47":"#1A1A1A",
                                  border:`1px solid ${sel?"#E8FF47":"#333"}`,
                                  display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", transition:"all 0.15s" }}>
                                {sel && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#080808" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
        </>}

        {/* ──────────── DATA ──────────── */}
        {activeTab === "data" && <>
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:20, fontWeight:700, color:"#FFF" }}>Volume Data</div>
            <div style={{ fontSize:13, color:"#555", marginTop:2 }}>Forecast vs Actuals — 24 months · live from Supabase</div>
          </div>
          <div style={{ display:"flex", gap:8, marginBottom:20, flexWrap:"wrap" }}>
            {CATEGORIES.map(cat => (
              <button key={cat} onClick={() => setFilterCat(prev=>prev===cat?"All":cat)}
                style={{ ...btnReset, padding:"6px 12px", borderRadius:6, fontSize:11, fontWeight:600,
                  border:`1px solid ${filterCat===cat?CATEGORY_COLORS[cat]:"#2A2A2A"}`,
                  background:filterCat===cat?`${CATEGORY_COLORS[cat]}18`:"transparent",
                  color:filterCat===cat?CATEGORY_COLORS[cat]:"#666", cursor:"pointer", transition:"all 0.15s" }}>
                {cat}
              </button>
            ))}
          </div>
          <div style={{ background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:12, overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", minWidth:900 }}>
                <thead>
                  <tr style={{ borderBottom:"1px solid #1A1A1A" }}>
                    <th style={thStyle}>Model</th>
                    <th style={thStyle}>Cat.</th>
                    <th style={thStyle}>Type</th>
                    {MONTHS.slice(0,12).map(m => <th key={m} style={{ ...thStyle, width:80 }}>{m.split(" ")[0]}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {products.filter(p=>filterCat==="All"||p.category===filterCat).map(p => {
                    const fd = volData[p.id];
                    return [
                      <tr key={`${p.id}-f`} className="row-hover" style={{ borderBottom:"1px solid #0F0F0F" }}>
                        <td style={{ padding:"9px 14px", fontSize:12, fontWeight:600, color:"#CCC" }} rowSpan={2}>{p.name}</td>
                        <td style={{ padding:"9px 14px", fontSize:10, color:CATEGORY_COLORS[p.category] }}>{p.category.split(" ")[0]}</td>
                        <td style={{ padding:"9px 14px" }}><span style={{ fontSize:9, color:"#777", textTransform:"uppercase", letterSpacing:1 }}>F</span></td>
                        {MONTHS.slice(0,12).map((m,mi) => (
                          <td key={m} style={{ padding:"9px 8px", fontSize:11, color:"#777", textAlign:"right", fontFamily:"'Space Mono',monospace" }}>
                            {fd?.forecast[mi]?.toLocaleString() || "-"}
                          </td>
                        ))}
                      </tr>,
                      <tr key={`${p.id}-a`} className="row-hover" style={{ borderBottom:"1px solid #131313" }}>
                        <td style={{ padding:"4px 14px 9px", fontSize:10, color:CATEGORY_COLORS[p.category] }}/>
                        <td style={{ padding:"4px 14px 9px" }}><span style={{ fontSize:9, color:"#47FFD4", textTransform:"uppercase", letterSpacing:1 }}>A</span></td>
                        {MONTHS.slice(0,12).map((m,mi) => {
                          const a=fd?.actuals[mi], f=fd?.forecast[mi];
                          const pct=a!=null&&f?Math.round(a/f*100):null;
                          return (
                            <td key={m} style={{ padding:"4px 8px 9px", fontSize:11, textAlign:"right", fontFamily:"'Space Mono',monospace",
                              color:a==null?"#333":pct>=100?"#10B981":pct>=80?"#F59E0B":"#EF4444" }}>
                              {a!=null?a.toLocaleString():"-"}
                            </td>
                          );
                        })}
                      </tr>,
                    ];
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ padding:"10px 14px", borderTop:"1px solid #1A1A1A", display:"flex", gap:16, fontSize:11, color:"#555" }}>
              <span style={{ color:"#777" }}>F = Forecast</span>
              <span style={{ color:"#47FFD4" }}>A = Actuals</span>
              <span style={{ color:"#10B981" }}>≥100%</span>
              <span style={{ color:"#F59E0B" }}>80–99%</span>
              <span style={{ color:"#EF4444" }}>&lt;80%</span>
            </div>
          </div>
        </>}

        {/* ──────────── UPLOAD ──────────── */}
        {activeTab === "upload" && <>
          <div style={{ marginBottom:28 }}>
            <div style={{ fontSize:20, fontWeight:700, color:"#FFF" }}>Data Upload</div>
            <div style={{ fontSize:13, color:"#555", marginTop:2 }}>All uploads write directly to Supabase — visible to all users instantly</div>
          </div>
          <div style={{ display:"grid", gap:12, maxWidth:720 }}>
            <SectionLabel label="Volume Forecasts" sub="Upload 24-month forward-looking volume plan"/>
            <FileDropZone label="Volume Forecast" onUpload={handleForecastUpload} templateType="forecast" accent="#47FFD4"/>
            <div style={{ height:8 }}/>
            <SectionLabel label="Monthly Actuals" sub="Upload actual shipped volumes — add each month"/>
            <FileDropZone label="Monthly Actuals" onUpload={handleActualsUpload} templateType="actuals" accent="#E8FF47"/>
            <div style={{ height:8 }}/>
            <SectionLabel label="Pricing & Costs" sub="Update ASP and BoM for each model"/>
            <FileDropZoneCost/>
          </div>

          <div style={{ marginTop:32, background:"#0D0D0D", border:"1px solid #1E1E1E", borderRadius:12, padding:24, maxWidth:720 }}>
            <div style={{ fontSize:13, fontWeight:600, color:"#FFF", marginBottom:16, fontFamily:"'Space Mono',monospace" }}>CSV FORMAT GUIDE</div>
            <div style={{ display:"grid", gap:16 }}>
              {[
                { label:"Forecast & Actuals", cols:"model, month, volume", example:"Spark 100, Jan 2025, 500\nVolt Jr, Feb 2025, 320" },
                { label:"Costs",              cols:"model, asp, bom",      example:"Spark 100, 89, 34\nVolt Jr, 249, 98" },
              ].map(g => (
                <div key={g.label} style={{ background:"#0A0A0A", borderRadius:8, padding:16, border:"1px solid #1A1A1A" }}>
                  <div style={{ fontSize:12, color:"#AAA", fontWeight:600, marginBottom:8 }}>{g.label}</div>
                  <div style={{ fontSize:11, color:"#555", marginBottom:8 }}>Columns: <span style={{ color:"#47FFD4", fontFamily:"monospace" }}>{g.cols}</span></div>
                  <pre style={{ fontSize:11, color:"#666", fontFamily:"monospace", lineHeight:1.8, margin:0 }}>{g.example}</pre>
                </div>
              ))}
            </div>
            <div style={{ marginTop:16, fontSize:12, color:"#444" }}>
              Month format: <span style={{ fontFamily:"monospace", color:"#555" }}>Jan 2025</span> · Model names must exactly match the catalogue · Uploads merge with existing data
            </div>
          </div>
        </>}

      </main>

      {/* ── ADD PRODUCT MODAL ── */}
      {modal === "addProduct" && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:999 }} onClick={() => setModal(null)}>
          <div style={{ background:"#0D0D0D", border:"1px solid #2A2A2A", borderRadius:14, padding:28, width:420, maxWidth:"90vw" }} onClick={e => e.stopPropagation()}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
              <div style={{ fontSize:16, fontWeight:700, color:"#FFF" }}>Add New Model</div>
              <button onClick={() => setModal(null)} style={{ ...btnReset, color:"#555", cursor:"pointer", padding:4 }}><Icon.X/></button>
            </div>
            <div style={{ display:"grid", gap:14 }}>
              <FormField label="Model Name">
                <input value={newProd.name} onChange={e=>setNewProd(p=>({...p,name:e.target.value}))} placeholder="e.g. Spark 300" style={inputStyle}/>
              </FormField>
              <FormField label="Category">
                <div style={{ position:"relative" }}>
                  <select value={newProd.category} onChange={e=>setNewProd(p=>({...p,category:e.target.value}))} style={{ ...inputStyle, paddingRight:28 }}>
                    {CATEGORIES.map(c=><option key={c} value={c}>{c}</option>)}
                  </select>
                  <div style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"#555" }}><Icon.ChevronDown/></div>
                </div>
              </FormField>
              <FormField label="Lifecycle Stage">
                <div style={{ position:"relative" }}>
                  <select value={newProd.stage} onChange={e=>setNewProd(p=>({...p,stage:e.target.value}))} style={{ ...inputStyle, paddingRight:28 }}>
                    {LIFECYCLE_STAGES.map(s=><option key={s} value={s}>{s}</option>)}
                  </select>
                  <div style={{ position:"absolute", right:10, top:"50%", transform:"translateY(-50%)", pointerEvents:"none", color:"#555" }}><Icon.ChevronDown/></div>
                </div>
              </FormField>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <FormField label="ASP ($)">
                  <input type="number" value={newProd.asp} onChange={e=>setNewProd(p=>({...p,asp:e.target.value}))} style={inputStyle}/>
                </FormField>
                <FormField label="BoM Cost ($)">
                  <input type="number" value={newProd.bom} onChange={e=>setNewProd(p=>({...p,bom:e.target.value}))} style={inputStyle}/>
                </FormField>
              </div>
            </div>
            <div style={{ display:"flex", gap:10, marginTop:22, justifyContent:"flex-end" }}>
              <button onClick={() => setModal(null)} style={btnStyle("#1A1A1A","#888")}>Cancel</button>
              <button onClick={addProduct} style={btnStyle("#E8FF47","#080808")}><Icon.Save/> Save to Database</button>
            </div>
          </div>
        </div>
      )}

      {/* ── RESET CONFIRM ── */}
      {confirmReset && (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.8)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:999 }} onClick={() => setConfirmReset(false)}>
          <div style={{ background:"#0D0D0D", border:"1px solid #EF444433", borderRadius:14, padding:28, width:380, maxWidth:"90vw", textAlign:"center" }} onClick={e => e.stopPropagation()}>
            <div style={{ width:44, height:44, background:"#EF444418", borderRadius:10, display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 16px" }}>
              <Icon.Trash/>
            </div>
            <div style={{ fontSize:16, fontWeight:700, color:"#FFF", marginBottom:8 }}>Reset all data?</div>
            <div style={{ fontSize:13, color:"#666", marginBottom:24, lineHeight:1.6 }}>
              This will <strong style={{ color:"#EF4444" }}>permanently delete</strong> all products, forecasts, and actuals from the database for all users, and restore the sample catalogue.
            </div>
            <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
              <button onClick={() => setConfirmReset(false)} style={btnStyle("#1A1A1A","#888")}>Cancel</button>
              <button onClick={handleReset} style={btnStyle("#EF4444","#FFF")}>Yes, reset everything</button>
            </div>
          </div>
        </div>
      )}

      {/* ── TOAST ── */}
      {toast && (
        <div style={{ position:"fixed", bottom:24, right:24,
          background: toast.type==="error" ? "#1A0A0A" : "#0A1A0A",
          border:`1px solid ${toast.type==="error"?"#EF4444":"#10B981"}`,
          borderRadius:8, padding:"12px 18px", display:"flex", alignItems:"center", gap:10,
          fontSize:13, color: toast.type==="error"?"#EF4444":"#10B981",
          boxShadow:"0 8px 32px rgba(0,0,0,0.6)", zIndex:9999, animation:"fadeUp 0.2s ease" }}>
          {toast.type==="error" ? "✕" : "✓"} {toast.msg}
        </div>
      )}
    </div>
  );
}
