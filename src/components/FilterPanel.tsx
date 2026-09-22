import { defaultParams, FILTERS, filterByName } from "../lib/filterShaders";
import { useStore } from "../lib/store";

export function FilterPanel() {
  const filters = useStore((s) => s.filters);
  const previewFilters = useStore((s) => s.previewFilters);
  const { addFilter, updateFilter, removeFilter, moveFilter, setPreviewFilters } = useStore.getState();

  return (
    <div className="filters">
      <h3>Filters</h3>
      <p className="hint">
        The same filters as 360mash, running the same shader maths. They are applied to the
        equirectangular frame, in order, before any text cards are drawn.
      </p>

      <div className="row">
        <select
          value=""
          onChange={(e) => { if (e.target.value) addFilter(e.target.value, defaultParams(e.target.value)); }}
        >
          <option value="">+ Add filter…</option>
          {FILTERS.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
      </div>

      <label className="row">
        <input type="checkbox" checked={previewFilters} onChange={(e) => setPreviewFilters(e.target.checked)} />
        Show filters in the preview
      </label>
      {!previewFilters && filters.length > 0 && (
        <p className="hint">Preview is unfiltered; the export still applies them.</p>
      )}

      {filters.length === 0 && <p className="hint">No filters. The video exports untouched.</p>}

      {filters.map((f, i) => {
        const def = filterByName(f.name);
        return (
          <div className="filter-item" key={f.id}>
            <div className="row">
              <b>{i + 1}. {f.name}</b>
              <span className="spacer" />
              <button onClick={() => moveFilter(f.id, -1)} disabled={i === 0} title="Earlier">▲</button>
              <button onClick={() => moveFilter(f.id, 1)} disabled={i === filters.length - 1} title="Later">▼</button>
              <button className="danger" onClick={() => removeFilter(f.id)}>×</button>
            </div>
            {def?.params.map((p) => (
              <label className="angle" key={p.key}>
                <span>{p.label}</span>
                <input
                  type="range" min={p.min} max={p.max} step={p.step}
                  value={f.params[p.key] ?? p.default}
                  onChange={(e) => updateFilter(f.id, { [p.key]: +e.target.value })}
                />
                <input
                  type="number" min={p.min} max={p.max} step={p.step}
                  value={f.params[p.key] ?? p.default}
                  onChange={(e) => updateFilter(f.id, { [p.key]: +e.target.value })}
                />
                <span className="unit" />
              </label>
            ))}
            {!def?.params.length && <div className="hint">No settings.</div>}
          </div>
        );
      })}
    </div>
  );
}
