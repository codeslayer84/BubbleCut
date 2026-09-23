import { useEffect, useState } from "react";
import { defaultParams, FILTERS, filterByName } from "../lib/filterShaders";
import { clipAt, useStore } from "../lib/store";

export function FilterPanel() {
  const clips = useStore((s) => s.clips);
  const media = useStore((s) => s.media);
  const selectedId = useStore((s) => s.selectedClipId);
  const playhead = useStore((s) => s.playhead);
  const previewFilters = useStore((s) => s.previewFilters);
  const presets = useStore((s) => s.presets);
  const [presetName, setPresetName] = useState("");
  const [chosenPreset, setChosenPreset] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);
  const {
    addFilter, updateFilter, removeFilter, moveFilter, copyFiltersToAllClips,
    setPreviewFilters, selectClip,
    refreshPresets, savePresetFromClip, deletePreset, applyPresetToClip,
  } = useStore.getState();

  useEffect(() => {
    void refreshPresets();
  }, []);

  // Edit whichever clip is selected, falling back to the one under the playhead.
  const clip = clips.find((c) => c.id === selectedId) ?? clipAt(clips, playhead)?.clip ?? null;

  if (!clip) {
    return <div className="filters"><h3>Filters</h3><p className="hint">Add a clip to the timeline first.</p></div>;
  }

  const filters = clip.filters;
  const name = media[clip.mediaPath]?.name ?? clip.mediaPath;

  return (
    <div className="filters">
      <h3>Filters <span className="hint">for this clip</span></h3>
      <p className="hint">
        The same filters as 360mash, running the same shader maths. Each clip has its own chain,
        applied to the equirectangular frame before any text cards are drawn.
      </p>

      <div className="kv">
        <span>Clip</span><span title={clip.mediaPath}>{name}</span>
      </div>
      {clips.length > 1 && (
        <div className="row">
          {clips.map((c, i) => (
            <button
              key={c.id}
              className={"chip" + (c.id === clip.id ? " on" : "")}
              onClick={() => selectClip(c.id)}
              title={media[c.mediaPath]?.name}
            >
              {i + 1}{c.filters.length ? ` ·${c.filters.length}` : ""}
            </button>
          ))}
        </div>
      )}

      <div className="row">
        <select
          value=""
          onChange={(e) => { if (e.target.value) addFilter(clip.id, e.target.value, defaultParams(e.target.value)); }}
        >
          <option value="">+ Add filter…</option>
          {FILTERS.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
        </select>
        {clips.length > 1 && filters.length > 0 && (
          <button onClick={() => copyFiltersToAllClips(clip.id)}>Apply to all clips</button>
        )}
      </div>

      <label className="row">
        <input type="checkbox" checked={previewFilters} onChange={(e) => setPreviewFilters(e.target.checked)} />
        Show filters in the preview
      </label>
      {!previewFilters && filters.length > 0 && (
        <p className="hint">Preview is unfiltered; the export still applies them.</p>
      )}

      <h3>Presets</h3>
      <div className="row">
        <select value={chosenPreset} onChange={(e) => setChosenPreset(e.target.value)}>
          <option value="">{presets.length ? "Choose a preset…" : "No presets saved yet"}</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} ({p.filters.length})
            </option>
          ))}
        </select>
        <button
          disabled={!chosenPreset}
          onClick={() => applyPresetToClip(clip.id, chosenPreset)}
          title="Replace this clip's filters with the preset"
        >
          Apply
        </button>
        <button
          className="danger"
          disabled={!chosenPreset}
          onClick={() => { void deletePreset(chosenPreset); setChosenPreset(""); }}
          title="Delete this preset"
        >
          ×
        </button>
      </div>
      <div className="row">
        <input
          type="text"
          placeholder="Name this look…"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && presetName.trim() && filters.length) {
              void savePresetFromClip(clip.id, presetName).then(setPresetError);
              setPresetName("");
            }
          }}
        />
        <button
          disabled={!presetName.trim() || filters.length === 0}
          onClick={() => {
            void savePresetFromClip(clip.id, presetName).then(setPresetError);
            setPresetName("");
          }}
          title="Save this clip's filters, with their settings, for reuse"
        >
          Save
        </button>
      </div>
      {presetError && <div className="error">Could not save the preset: {presetError}</div>}
      <p className="hint">
        Presets keep the filters and their settings, and are shared across projects.
        {presets.some((p) => p.name === presetName.trim()) && presetName.trim()
          ? " Saving replaces the preset of that name."
          : ""}
      </p>

      {filters.length === 0 && <p className="hint">No filters on this clip. It exports untouched.</p>}

      {filters.map((f, i) => {
        const def = filterByName(f.name);
        return (
          <div className="filter-item" key={f.id}>
            <div className="row">
              <b>{i + 1}. {f.name}</b>
              <span className="spacer" />
              <button onClick={() => moveFilter(clip.id, f.id, -1)} disabled={i === 0} title="Earlier">▲</button>
              <button onClick={() => moveFilter(clip.id, f.id, 1)} disabled={i === filters.length - 1} title="Later">▼</button>
              <button className="danger" onClick={() => removeFilter(clip.id, f.id)}>×</button>
            </div>
            {def?.params.map((p) => (
              <label className="angle" key={p.key}>
                <span>{p.label}</span>
                <input
                  type="range" min={p.min} max={p.max} step={p.step}
                  value={f.params[p.key] ?? p.default}
                  onChange={(e) => updateFilter(clip.id, f.id, { [p.key]: +e.target.value })}
                />
                <input
                  type="number" min={p.min} max={p.max} step={p.step}
                  value={f.params[p.key] ?? p.default}
                  onChange={(e) => updateFilter(clip.id, f.id, { [p.key]: +e.target.value })}
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
