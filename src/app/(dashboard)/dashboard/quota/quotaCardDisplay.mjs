const GROUPS = new Set(["summary", "text", "images"]);

export function cardImageCollapse(visibility = {}, legacy = { all: false, overrides: {} }) {
  const saved = visibility.cardRowsV1?.images;
  return saved && typeof saved.all === "boolean" && saved.overrides && typeof saved.overrides === "object" ? saved : legacy;
}

export function cardGroupVisible(visibility, id, group, legacy) {
  const shared = visibility.cardRowsV1?.sharedGroups?.[group];
  if (typeof shared === "boolean") return shared;
  if (group === "images") {
    const collapse = cardImageCollapse(visibility, legacy);
    return !(collapse.overrides[id] ?? collapse.all);
  }
  const saved = visibility.cardRowsV1?.groups?.[id]?.[group];
  return typeof saved === "boolean" ? saved : group === "summary";
}

export function setCardGroupVisible(visibility, id, group, visible, legacy) {
  if (!GROUPS.has(group) || typeof visible !== "boolean") return visibility;
  const current = visibility.cardRowsV1 || {};
  if (group === "images") {
    const collapse = cardImageCollapse(visibility, legacy);
    const overrides = { ...collapse.overrides };
    if (!visible === collapse.all) delete overrides[id]; else overrides[id] = !visible;
    return { ...visibility, cardRowsV1: { ...current, images: { ...collapse, overrides } } };
  }
  return { ...visibility, cardRowsV1: { ...current, groups: { ...current.groups,
    [id]: { ...current.groups?.[id], [group]: visible } } } };
}

export function setAllImageSummariesVisible(visibility, visible) {
  return { ...visibility, cardRowsV1: { ...visibility.cardRowsV1, images: { all: !visible, overrides: {} } } };
}

export function cardModelVisibilityKey(provider, group, model) {
  return JSON.stringify([provider, group, model]);
}

export function cardModelVisible(visibility, provider, group, model) {
  return visibility.cardRowsV1?.models?.[cardModelVisibilityKey(provider, group, model)] === true;
}

export function setCardModelVisible(visibility, { id, provider, group, model, visible, legacy }) {
  if (!["text", "images"].includes(group) || !provider || !model || typeof visible !== "boolean") return visibility;
  const next = { ...visibility, cardRowsV1: { ...visibility.cardRowsV1, models: {
    ...visibility.cardRowsV1?.models, [cardModelVisibilityKey(provider, group, model)]: visible,
  } } };
  return visible ? setCardGroupVisible(next, id, group, true, legacy) : next;
}

// Section visibility is shared; model permissions and tests remain account-scoped.
export function setSharedCardGroupVisible(visibility, group, visible) {
  if (!GROUPS.has(group) || typeof visible !== 'boolean') return visibility;
  return {...visibility, cardRowsV1: {...visibility.cardRowsV1, sharedGroups: {...visibility.cardRowsV1?.sharedGroups, [group]:visible}}};
}
export function setAllCardSectionsVisible(visibility, all) {
  return {...visibility, cardRowsV1: {...visibility.cardRowsV1, sharedGroups: {summary:true,text:all,images:all}}};
}
export function selectedCardModels(models, selected, filter = '', kind = '') {
  return models.filter(model => filter ? model.id === filter && (!kind || model.kind === kind) : selected(model)).map(model => model.id);
}
