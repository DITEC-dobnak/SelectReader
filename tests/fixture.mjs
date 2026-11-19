export const selection = { server: 'test-server', repository: 'TestRepo', model: 'TestModel' };
export const diagram = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Prihlásenie', type: 'Use Case Diagram', path: 'Test/Prihlásenie' };
export const item = { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Používateľ', type: 'Class', path: 'Test/Používateľ' };
export const snapshot = {
  version: 1, selection, entries: [diagram, item], complete: true, detailsComplete: false,
  updatedAt: '2026-01-01T10:00:00Z',
  details: [[diagram.id, {
    id: diagram.id, attributes: { Popis: 'Overenie prístupových práv' },
    relations: [{ role: 'Súvisiaci objekt', item }],
    diagram: { symbols: [{
      id: 'one', fields: { Type: 'UCD::Use Case', Position: '20 20', Width: '180', Height: '100', 'Dictionary Item Name': 'Prihlásenie používateľa' },
      target: item, endpoints: [],
    }] },
    warnings: [], loadedAt: '2026-01-01T10:00:00Z', sourceMs: 2,
  }]],
};
