'use strict';

// Devine la cause d'un pic de performance. L'ordre des tests compte :
// la premiere regle qui correspond gagne.
function classifyReport(report) {
  if (report?.reason === 'network') return 'network';
  if (report?.activities?.some((a) => a.name === 'visibilityHidden')) return 'hidden';
  if (report?.graphics?.firstCapture || report?.graphics?.newPrograms > 20) return 'shader';
  if (report?.work?.details?.renderOverlay > 100) return 'overlay';
  if (report?.work?.details?.worldDynamics > 30) return 'world';
  return 'generic';
}

// Rapport physiquement impossible : fps au-dessus du plafond du jeu (144)
// ou image plus courte que le travail qu'elle contient (1 ms de marge pour l'arrondi).
function isSuspicious(report) {
  return report?.fps > 144 || report?.frameMs < report?.work?.totalMs - 1;
}

module.exports = { classifyReport, isSuspicious };
