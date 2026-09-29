/**
 * Localized strings for the Graphics settings section. The game has no
 * language setting, so the locale follows navigator.language, falling back by
 * language prefix and finally to en-US.
 */

const shadowsN = (word) => (n) => `${word} ${n}²`;

const EN = {
  graphics: 'Graphics',
  quality: 'Quality',
  auto: (tier) => `Auto (detected: ${tier})`,
  presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
  renderScale: 'Render scale',
  fromPreset: (tier) => `From preset (${tier})`,
  categories: {
    shadows: 'Shadows',
    ao: 'Ambient occlusion',
    bloom: 'Bloom',
    grade: 'Color grade',
    antialias: 'Anti-aliasing',
    reflections: 'Reflections',
    particles: 'Particles',
    background: 'Background motion',
    detail: 'Surface detail',
  },
  tiers: {
    off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Static', animated: 'Animated', plain: 'Plain', detailed: 'Detailed',
  },
  adaptive: 'Adaptive resolution',
  showFps: 'Show frame rate',
  postUnavailable: 'Post-processing is unavailable on this device, so the table is drawn without it.',
  words: {
    noShadows: 'no shadows',
    shadows: (n) => `${n}² shadows`,
    ao: 'ambient occlusion',
    aoHigh: 'full ambient occlusion',
    bloom: 'bloom',
    noAA: 'no anti-aliasing',
    reflections: 'reflections',
    particles: { low: 'few particles', medium: 'some particles', high: 'full particles' },
  },
};

const EN_GB = {
  ...EN,
  categories: { ...EN.categories, grade: 'Colour grade' },
};

const ES_419 = {
  graphics: 'Gráficos',
  quality: 'Calidad',
  auto: (tier) => `Automática (detectada: ${tier})`,
  presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderizado',
  fromPreset: (tier) => `Según el ajuste (${tier})`,
  categories: {
    shadows: 'Sombras',
    ao: 'Oclusión ambiental',
    bloom: 'Resplandor',
    grade: 'Corrección de color',
    antialias: 'Antialiasing',
    reflections: 'Reflejos',
    particles: 'Partículas',
    background: 'Movimiento del fondo',
    detail: 'Detalle de superficies',
  },
  tiers: {
    off: 'Desactivado', on: 'Activado', low: 'Bajo', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Estático', animated: 'Animado', plain: 'Simple', detailed: 'Detallado',
  },
  adaptive: 'Resolución adaptable',
  showFps: 'Mostrar cuadros por segundo',
  postUnavailable: 'El posprocesamiento no está disponible en este dispositivo; la mesa se dibuja sin él.',
  words: {
    noShadows: 'sin sombras',
    shadows: shadowsN('sombras'),
    ao: 'oclusión ambiental',
    aoHigh: 'oclusión ambiental completa',
    bloom: 'resplandor',
    noAA: 'sin antialiasing',
    reflections: 'reflejos',
    particles: { low: 'pocas partículas', medium: 'algunas partículas', high: 'todas las partículas' },
  },
};

const ES_ES = {
  ...ES_419,
  auto: (tier) => `Automática (detectada: ${tier})`,
  showFps: 'Mostrar fotogramas por segundo',
  categories: { ...ES_419.categories, ao: 'Oclusión ambiental', bloom: 'Resplandor (bloom)' },
};

const DE = {
  graphics: 'Grafik',
  quality: 'Qualität',
  auto: (tier) => `Automatisch (erkannt: ${tier})`,
  presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
  renderScale: 'Renderskalierung',
  fromPreset: (tier) => `Aus Voreinstellung (${tier})`,
  categories: {
    shadows: 'Schatten',
    ao: 'Umgebungsverdeckung',
    bloom: 'Bloom',
    grade: 'Farbkorrektur',
    antialias: 'Kantenglättung',
    reflections: 'Spiegelungen',
    particles: 'Partikel',
    background: 'Hintergrundbewegung',
    detail: 'Oberflächendetails',
  },
  tiers: {
    off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statisch', animated: 'Animiert', plain: 'Einfach', detailed: 'Detailliert',
  },
  adaptive: 'Adaptive Auflösung',
  showFps: 'Bildrate anzeigen',
  postUnavailable: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; der Tisch wird ohne sie gezeichnet.',
  words: {
    noShadows: 'keine Schatten',
    shadows: shadowsN('Schatten'),
    ao: 'Umgebungsverdeckung',
    aoHigh: 'volle Umgebungsverdeckung',
    bloom: 'Bloom',
    noAA: 'keine Kantenglättung',
    reflections: 'Spiegelungen',
    particles: { low: 'wenige Partikel', medium: 'einige Partikel', high: 'alle Partikel' },
  },
};

const FR = {
  graphics: 'Graphismes',
  quality: 'Qualité',
  auto: (tier) => `Auto (détectée : ${tier})`,
  presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
  renderScale: 'Échelle de rendu',
  fromPreset: (tier) => `Selon le préréglage (${tier})`,
  categories: {
    shadows: 'Ombres',
    ao: 'Occlusion ambiante',
    bloom: 'Halo lumineux',
    grade: 'Étalonnage des couleurs',
    antialias: 'Anticrénelage',
    reflections: 'Reflets',
    particles: 'Particules',
    background: 'Animation du décor',
    detail: 'Détail des surfaces',
  },
  tiers: {
    off: 'Désactivé', on: 'Activé', low: 'Bas', medium: 'Moyen', high: 'Élevé',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statique', animated: 'Animé', plain: 'Simple', detailed: 'Détaillé',
  },
  adaptive: 'Résolution adaptative',
  showFps: 'Afficher les images par seconde',
  postUnavailable: 'Le post-traitement n’est pas disponible sur cet appareil ; la table est dessinée sans.',
  words: {
    noShadows: 'sans ombres',
    shadows: shadowsN('ombres'),
    ao: 'occlusion ambiante',
    aoHigh: 'occlusion ambiante complète',
    bloom: 'halo lumineux',
    noAA: 'sans anticrénelage',
    reflections: 'reflets',
    particles: { low: 'peu de particules', medium: 'quelques particules', high: 'toutes les particules' },
  },
};

const FR_CA = {
  ...FR,
  categories: { ...FR.categories, antialias: 'Anticrénelage (lissage)' },
  showFps: 'Afficher la fréquence d’images',
  postUnavailable: 'Le post-traitement n’est pas offert sur cet appareil; la table est dessinée sans.',
};

const PT_BR = {
  graphics: 'Gráficos',
  quality: 'Qualidade',
  auto: (tier) => `Automática (detectada: ${tier})`,
  presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Escala de renderização',
  fromPreset: (tier) => `Da predefinição (${tier})`,
  categories: {
    shadows: 'Sombras',
    ao: 'Oclusão de ambiente',
    bloom: 'Brilho',
    grade: 'Correção de cor',
    antialias: 'Antisserrilhamento',
    reflections: 'Reflexos',
    particles: 'Partículas',
    background: 'Movimento do cenário',
    detail: 'Detalhe das superfícies',
  },
  tiers: {
    off: 'Desligado', on: 'Ligado', low: 'Baixo', medium: 'Médio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Estático', animated: 'Animado', plain: 'Simples', detailed: 'Detalhado',
  },
  adaptive: 'Resolução adaptável',
  showFps: 'Mostrar taxa de quadros',
  postUnavailable: 'O pós-processamento não está disponível neste dispositivo; a mesa é desenhada sem ele.',
  words: {
    noShadows: 'sem sombras',
    shadows: shadowsN('sombras'),
    ao: 'oclusão de ambiente',
    aoHigh: 'oclusão de ambiente completa',
    bloom: 'brilho',
    noAA: 'sem antisserrilhamento',
    reflections: 'reflexos',
    particles: { low: 'poucas partículas', medium: 'algumas partículas', high: 'todas as partículas' },
  },
};

const IT = {
  graphics: 'Grafica',
  quality: 'Qualità',
  auto: (tier) => `Automatica (rilevata: ${tier})`,
  presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
  renderScale: 'Scala di rendering',
  fromPreset: (tier) => `Dalla preimpostazione (${tier})`,
  categories: {
    shadows: 'Ombre',
    ao: 'Occlusione ambientale',
    bloom: 'Bagliore',
    grade: 'Correzione colore',
    antialias: 'Antialiasing',
    reflections: 'Riflessi',
    particles: 'Particelle',
    background: 'Movimento dello sfondo',
    detail: 'Dettaglio superfici',
  },
  tiers: {
    off: 'No', on: 'Sì', low: 'Basso', medium: 'Medio', high: 'Alto',
    fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA',
    static: 'Statico', animated: 'Animato', plain: 'Semplice', detailed: 'Dettagliato',
  },
  adaptive: 'Risoluzione adattiva',
  showFps: 'Mostra frequenza fotogrammi',
  postUnavailable: 'La post-elaborazione non è disponibile su questo dispositivo; il tavolo viene disegnato senza.',
  words: {
    noShadows: 'nessuna ombra',
    shadows: shadowsN('ombre'),
    ao: 'occlusione ambientale',
    aoHigh: 'occlusione ambientale completa',
    bloom: 'bagliore',
    noAA: 'nessun antialiasing',
    reflections: 'riflessi',
    particles: { low: 'poche particelle', medium: 'alcune particelle', high: 'tutte le particelle' },
  },
};

export const GFX_STRINGS = {
  'en-US': EN,
  'en-GB': EN_GB,
  'es-419': ES_419,
  'es-ES': ES_ES,
  'de-DE': DE,
  'fr-FR': FR,
  'fr-CA': FR_CA,
  'pt-BR': PT_BR,
  'it-IT': IT,
};

const PREFIX_DEFAULT = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Pick the best supported locale for a BCP-47 tag (e.g. navigator.language). */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  const exact = Object.keys(GFX_STRINGS).find((k) => k.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const lang = t.split(/[-_]/)[0].toLowerCase();
  if (lang === 'en' && /-(gb|uk|ie|au|nz|za|in)$/i.test(t)) return 'en-GB';
  if (lang === 'es' && /-es$/i.test(t)) return 'es-ES';
  if (lang === 'fr' && /-ca$/i.test(t)) return 'fr-CA';
  return PREFIX_DEFAULT[lang] ?? 'en-US';
}

export function gfxStrings(tag = globalThis.navigator?.language) {
  return GFX_STRINGS[pickLocale(tag)];
}
