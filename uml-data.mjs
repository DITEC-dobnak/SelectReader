function relationItems(data, role) {
  return data.relations.filter(relation => relation.role === role).map(relation => relation.item);
}

function dataType(data) {
  return data.relations.find(relation => /_To_(?:DataType|ReturnType)$/.test(relation.role))?.item.name ?? '';
}

export function classStereotype(value) {
  return ({ 1: 'user', 2: 'interface' })[value] ?? '';
}

function classSymbol(symbol) {
  return symbol.nativeClass === '_Ent2_CDClass' || symbol.fields.Type === 'CD::Class';
}

async function packagePath(item, orderedItems) {
  const names = [], seen = new Set();
  while (item) {
    if (seen.has(item.id)) throw new Error('Cycle in package hierarchy.');
    seen.add(item.id);
    names.unshift(item.name);
    [item] = await orderedItems(item, '_Ent2_ScopedPackage_To_Container', '_Ent2_Package');
  }
  return names.join('::');
}

export async function classDiagramData(symbols, read, orderedItems, classCache, exportMode = false) {
  const classes = [], edges = [], notes = [];
  for (const symbol of symbols) {
    if (classSymbol(symbol) && symbol.target) {
      const presentation = { id: symbol.id, target: symbol.target, name: symbol.target.name, signature: symbol.fields.ViewShowSignature !== 'false' };
      const frame = symbol.relations?.find(r => r.role === '_Ent2_CDClass_To_CDPackage');
      if (exportMode && frame) {
        const pkg = symbols.find(s => s.id === frame.item.id)?.target;
        if (pkg) presentation.home = await packagePath(pkg, orderedItems);
      }
      const cached = classCache?.get(symbol.target.id);
      if (cached) {
        classes.push({ ...cached, ...presentation });
        continue;
      }
      const data = await read(symbol.target);
      const attributes = [], operations = [];
      for (const item of relationItems(data, '_Ent2_Class_To_Attribute')) {
        const member = await read(item);
        attributes.push({ id: item.id, target: item, name: item.name, type: dataType(member),
          isStatic: member.attributes.IsStatic === 'true', access: member.attributes.Access,
          description: member.attributes.Description, optional: member.attributes.IsOptional === 'true', defaultValue: member.attributes.DefaultValue,
          initial: member.attributes.InitialValue ?? '' });
      }
      for (const item of relationItems(data, '_Ent2_Class_To_Operation')) {
        const member = await read(item), parameters = [];
        const parameterItems = relationItems(member, '_Ent2_Operation_To_Parameter');
        const parametersInOrder = parameterItems.length > 1 ?
          await orderedItems(item, '_Ent2_Operation_To_Parameter', '_Ent2_Parameter') : parameterItems;
        if (parametersInOrder.length !== parameterItems.length ||
            parametersInOrder.some(parameter => !parameterItems.some(item => item.id === parameter.id)))
          throw new Error('Operation parameter order is incomplete.');
        for (const parameter of parametersInOrder) {
          const value = await read(parameter);
          const direction = exportMode && ({0:'in',1:'out',2:'inout'})[value.attributes.Mechanism];
          parameters.push(`${direction ? `${direction} ` : ''}${parameter.name}${dataType(value) ? `: ${dataType(value)}` : ''}`);
        }
        operations.push({ id: item.id, target: item, name: item.name, parameters, type: dataType(member),
          description: member.attributes.Description,
          isStatic: member.attributes.IsStatic === 'true', isAbstract: member.attributes.IsAbstract === 'true' });
      }
      const pkg = relationItems(data, '_Ent2_Class_To_Namespace')[0];
      const definition = { attributes, operations,
        stereotype: data.attributes.Stereotype === '0' ? 'business' : classStereotype(data.attributes.Stereotype),
        custom: relationItems(data, '_Ent2_UserStereotypedItem_To_UserStereotype').map(item => item.name),
        description: data.attributes.Description,
        namespace: exportMode && pkg?.nativeClass === '_Ent2_Package' ? await packagePath(pkg, orderedItems) : pkg?.name ?? '',
        isAbstract: data.attributes.IsAbstract === 'true' };
      if (classCache) {
        if (classCache.size >= 512) classCache.delete(classCache.keys().next().value);
        classCache.set(symbol.target.id, definition);
      }
      classes.push({ ...definition, ...presentation });
    } else if (symbol.target?.nativeClass === '_Ent2_Association') {
      const data = await read(symbol.target), ends = [];
      for (const item of relationItems(data, '_Ent2_Association_To_Role')) {
        const role = await read(item);
        const target = relationItems(role, '_Ent2_Role_To_Class')[0];
        const end = role.attributes.AssociationEnd;
        if (!target || !['0', '1'].includes(end)) throw new Error('Association end has no verified class or direction.');
        ends.push({ end: Number(end), classId: target.id, name: item.name,
          multiplicity: data.attributes[end === '0' ? 'StartMultiplicityUML' : 'EndMultiplicityUML'] ?? '' });
      }
      if (ends.length !== 2 || new Set(ends.map(end => end.end)).size !== 2)
        throw new Error('Association does not have two distinct semantic ends.');
      edges.push({ id: symbol.id, target: symbol.target, type: 'association', ends: ends.sort((a, b) => a.end - b.end),
        symbolIds: symbol.endpoints.filter(endpoint => symbols.some(candidate => candidate.id === endpoint.id && classSymbol(candidate))).map(endpoint => endpoint.id),
        label: symbol.target.name === 'Associates' ? '' : symbol.target.name });
    } else if (/generalization|dependency/i.test(symbol.fields.Type)) {
      const generalization = /generalization/i.test(symbol.fields.Type);
      const source = symbol.relations.find(relation => (generalization ? /_To_SubClassSymbol$/ : /_To_DependentSymbol$/).test(relation.role))?.item;
      const target = symbol.relations.find(relation => (generalization ? /_To_SuperClassSymbol$/ : /_To_DependeeSymbol$/).test(relation.role))?.item;
      if (!source || !target) throw new Error('UML inheritance/dependency has no verified direction.');
      edges.push({ id: symbol.id, type: generalization ? 'generalization' : 'dependency',
        label: generalization ? '' : symbol.target?.name ?? '', symbolIds: [source.id, target.id], target: symbol.target });
    } else if (symbol.fields.Type === 'Note') {
      notes.push({ id: symbol.id, text: symbol.fields.Text ?? symbol.fields.Description ?? '' });
    }
  }
  return { kind: 'class', classes, edges, notes };
}

export async function sequenceDiagramData(symbols, orderedChildren, {allowUnplaced=false}={}) {
  const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));
  const participants = symbols.filter(symbol => /^(?:OSD Instance|OSD Actor|OSD System Boundary)$/.test(symbol.fields.Type))
    .map(symbol => ({ id: symbol.id, name: symbol.target ?
      `${symbol.fields.Name && !['Instance', 'Actor'].includes(symbol.fields.Name) ? `${symbol.fields.Name}: ` : ''}${symbol.target.name}` :
      symbol.fields.Name ?? symbol.fields.Type,
      target: symbol.target, x: Number(symbol.fields.Position?.split(/\s+/)[0] ?? 0) }))
    .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  const participantIds = new Set(participants.map(participant => participant.id));
  const steps = symbols.filter(symbol => symbol.fields.Type === 'OSD Step');
  const childMap = new Map(), childIds = new Set();
  for (const step of steps) {
    const children = step.relations.filter(relation => relation.role === '_Ent2_ParentStep_To_ChildStep').map(relation => relation.item);
    const ordered = children.length > 1 ? await orderedChildren(step, children) : children;
    if (ordered.length !== children.length || new Set(ordered.map(item => item.id)).size !== children.length ||
        ordered.some(item => !children.some(child => child.id === item.id)))
      throw new Error('Stored sequence child ordering is incomplete.');
    childMap.set(step.id, ordered.map(item => item.id));
    for (const child of ordered) {
      if (!byId.has(child.id) || childIds.has(child.id)) throw new Error('Sequence step has a missing or multiple parent.');
      childIds.add(child.id);
    }
  }
  let roots = steps.filter(step => !childIds.has(step.id));
  if (roots.length > 1) {
    const headings = symbols.filter(symbol => symbol.nativeClass === '_Ent2_OSDStructuredDescriptionHeading');
    if (headings.length !== 1) throw new Error('Sequence has no unique ordered heading.');
    const role = '_Ent2_OSDStructuredDescriptionHeading_To_OSDStep';
    const members = headings[0].relations.filter(relation => relation.role === role).map(relation => relation.item);
    const ordered = await orderedChildren(headings[0], members, role);
    const rootIds = new Set(roots.map(step => step.id));
    if (ordered.length !== roots.length || new Set(ordered.map(step => step.id)).size !== roots.length ||
        ordered.some(step => !rootIds.has(step.id))) throw new Error('Stored sequence root ordering is incomplete.');
    roots = ordered;
  }
  const messages = new Map(), usedMessages = new Set();
  const probes = new Map();
  for (const symbol of symbols.filter(symbol => symbol.fields.Type === 'OSD Probe')) {
    const steps = symbol.relations.filter(relation => relation.item.nativeClass === '_Ent2_OSDStep');
    const lines = symbol.relations.filter(relation => participantIds.has(relation.item.id));
    if (steps.length !== 1 || lines.length !== 1) throw new Error('Sequence probe has no unique verified step and participant.');
    const list = probes.get(steps[0].item.id) ?? [];
    list.push({ kind: 'probe', id: symbol.id, participant: lines[0].item.id, target: symbol.target,
      label: `«probe» ${symbol.target?.name ?? symbol.fields.Name}`, probeType: symbol.fields.ProbeType });
    probes.set(steps[0].item.id, list);
  }
  for (const symbol of symbols.filter(symbol => /OSD (?:Operation|Event) Message/.test(symbol.fields.Type))) {
    const step = symbol.relations.find(relation => /Message_To_OSDStep$/.test(relation.role))?.item;
    const source = symbol.relations.find(relation => relation.role === '_Ent2_MessageSymbolStart_To_SendingObjectLine')?.item;
    const target = symbol.relations.find(relation => relation.role === '_Ent2_MessageSymbolEnd_To_ReceivingObjectLine')?.item;
    if (!step || !byId.has(step.id) || !participantIds.has(source?.id) || !participantIds.has(target?.id))
      throw new Error('Sequence message has no verified step, sender or receiver.');
    if (messages.has(step.id)) throw new Error('Sequence step contains multiple unordered messages.');
    messages.set(step.id, { id: symbol.id, source: source.id, destination: target.id, target: symbol.target,
      label: `${symbol.target?.name ?? symbol.fields.Name}${symbol.fields.ActualParameters ? `(${symbol.fields.ActualParameters})` : ''}`,
      event: symbol.fields.Type === 'OSD Event Message' });
  }
  const rows = [], visited = new Set();
  const visit = (id, depth, number) => {
    if (visited.has(id)) throw new Error('Cycle in stored sequence order.');
    visited.add(id);
    const step = byId.get(id);
    rows.push({ kind: 'note', id, text: step.fields.Text ?? '', depth, number, stepId: id });
    const message = messages.get(id);
    if (message) {
      usedMessages.add(message.id);
      rows.push({ kind: 'message', ...message, depth, stepId: id });
    }
    rows.push(...(probes.get(id) ?? []).map(row => ({ ...row, depth, stepId: id })));
    (childMap.get(id) ?? []).forEach((child, index) => visit(child, depth + 1, `${number}.${index + 1}`));
  };
  roots.forEach((root, index) => visit(root.id, 0, String(index + 1)));
  if (!allowUnplaced && (visited.size !== steps.length || usedMessages.size !== messages.size))
    throw Object.assign(new Error(`Podľa uložených väzieb sa podarilo zoradiť ${visited.size}/${steps.length} krokov a ${usedMessages.size}/${messages.size} správ SQD.`), {code:'SQD_INCOMPLETE_ORDER'});
  const unplaced=[];
  if(allowUnplaced) for(const step of steps.filter(s=>!visited.has(s.id))) {
    unplaced.push({kind:'note',id:step.id,text:step.fields.Text ?? '',stepId:step.id});
    const message=messages.get(step.id);
    if(message) unplaced.push({kind:'message',...message,stepId:step.id});
    unplaced.push(...(probes.get(step.id)??[]).map(r=>({...r,stepId:step.id})));
  }
  const stepIds=new Set(steps.map(s=>s.id));
  if ([...probes.keys(),...messages.keys()].some(id => !stepIds.has(id))) throw new Error('Sequence message or probe has no verified step.');
  return { kind: 'sequence', participants, rows, stepCount: steps.length, messageCount: messages.size,
    probeCount: [...probes.values()].reduce((count, values) => count + values.length, 0),
    ...(unplaced.length ? {unplaced,unplacedCount:steps.length-visited.size} : {}) };
}
