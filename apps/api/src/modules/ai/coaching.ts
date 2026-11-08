/**
 * Training advice belongs to Mark's coach (D42). When a question asks for it, the user turn gets this note on top of
 * the system prompt rule, so the model answers with Garmin facts and points to the coach.
 */
const ADVICE =
  /\b(should i|what should i|what do you (recommend|suggest)|recommend|suggest|advise|advice|how (hard|fast|far|long|much) (should|do i|can i)|what (workout|session|pace|run) (should|do|shall)|how (do|should) i (train|taper|prepare|peak)|can i (run|train|race|go)|do i (rest|run|train|need)|is it (ok|safe|fine|worth)|training plan|taper)\b/i;

export const mentionsTrainingAdvice = (text: string): boolean => ADVICE.test(text);

export const COACH_NOTE = "[This question asks for training advice. Give only the facts from Garmin that bear on it, with their dates, and say that the question is for the coach. Do not answer the advice itself.]";
