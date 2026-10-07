/**
 * Strings for the StarHermit buttons and toasts (sign-in, invite, signed
 * out) and the results leaderboard line. Locale follows navigator.language like the Graphics strings.
 */

import { pickLocale } from './gfx-strings.js';

const EN = {
  signIn: 'Sign in with StarHermit',
  invite: 'Invite a friend',
  inviteCopied: 'Invite link copied to the clipboard.',
  inviteFailed: 'Could not copy. Invite link: {link}',
  signedOut: 'Signed out of StarHermit — playing locally.',
  lbPosting: 'Posting score to the leaderboard…',
  lbRank: 'Leaderboard rank: #{rank}',
  lbPosted: 'Score posted to the leaderboard.',
  lbNotPosted: 'Score not posted to the leaderboard.',
};

const STRINGS = {
  'en-US': EN,
  'en-GB': EN,
  'es-419': {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado al portapapeles.',
    inviteFailed: 'No se pudo copiar. Enlace de invitación: {link}',
    signedOut: 'Se cerró la sesión de StarHermit: juegas en modo local.',
    lbPosting: 'Enviando la puntuación a la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación enviada a la clasificación.',
    lbNotPosted: 'No se envió la puntuación a la clasificación.',
  },
  'es-ES': {
    signIn: 'Iniciar sesión con StarHermit',
    invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado al portapapeles.',
    inviteFailed: 'No se ha podido copiar. Enlace de invitación: {link}',
    signedOut: 'Se ha cerrado la sesión de StarHermit: juegas en local.',
    lbPosting: 'Enviando la puntuación a la clasificación…',
    lbRank: 'Puesto en la clasificación: #{rank}',
    lbPosted: 'Puntuación enviada a la clasificación.',
    lbNotPosted: 'No se ha enviado la puntuación a la clasificación.',
  },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden',
    invite: 'Freund einladen',
    inviteCopied: 'Einladungslink in die Zwischenablage kopiert.',
    inviteFailed: 'Kopieren fehlgeschlagen. Einladungslink: {link}',
    signedOut: 'Von StarHermit abgemeldet – du spielst lokal weiter.',
    lbPosting: 'Punktzahl wird an die Bestenliste gesendet …',
    lbRank: 'Platz in der Bestenliste: #{rank}',
    lbPosted: 'Punktzahl an die Bestenliste gesendet.',
    lbNotPosted: 'Punktzahl nicht an die Bestenliste gesendet.',
  },
  'fr-FR': {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers.',
    inviteFailed: 'Copie impossible. Lien d’invitation : {link}',
    signedOut: 'Déconnecté de StarHermit — vous jouez en local.',
    lbPosting: 'Envoi du score au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Score envoyé au classement.',
    lbNotPosted: 'Score non envoyé au classement.',
  },
  'fr-CA': {
    signIn: 'Se connecter avec StarHermit',
    invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers.',
    inviteFailed: 'Impossible de copier. Lien d’invitation : {link}',
    signedOut: 'Déconnecté de StarHermit — vous jouez en mode local.',
    lbPosting: 'Envoi du pointage au classement…',
    lbRank: 'Rang au classement : #{rank}',
    lbPosted: 'Pointage envoyé au classement.',
    lbNotPosted: 'Pointage non envoyé au classement.',
  },
  'pt-BR': {
    signIn: 'Entrar com StarHermit',
    invite: 'Convidar um amigo',
    inviteCopied: 'Link de convite copiado para a área de transferência.',
    inviteFailed: 'Não foi possível copiar. Link de convite: {link}',
    signedOut: 'Você saiu do StarHermit — jogando localmente.',
    lbPosting: 'Enviando a pontuação para o ranking…',
    lbRank: 'Posição no ranking: #{rank}',
    lbPosted: 'Pontuação enviada para o ranking.',
    lbNotPosted: 'A pontuação não foi enviada para o ranking.',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit',
    invite: 'Invita un amico',
    inviteCopied: 'Link di invito copiato negli appunti.',
    inviteFailed: 'Impossibile copiare. Link di invito: {link}',
    signedOut: 'Disconnesso da StarHermit: giochi in locale.',
    lbPosting: 'Invio del punteggio alla classifica…',
    lbRank: 'Posizione in classifica: #{rank}',
    lbPosted: 'Punteggio inviato alla classifica.',
    lbNotPosted: 'Punteggio non inviato alla classifica.',
  },
};

/** Translator for a locale with English fallback. */
export function platformStrings(locale = globalThis.navigator?.language) {
  const table = STRINGS[pickLocale(locale)] || EN;
  return (key, vars) => {
    let s = table[key] !== undefined ? table[key] : (EN[key] !== undefined ? EN[key] : key);
    if (vars) for (const k in vars) s = s.replace('{' + k + '}', vars[k]);
    return s;
  };
}

export { STRINGS as PLATFORM_STRINGS };
