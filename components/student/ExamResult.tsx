import React, { useState, useEffect, useRef } from 'react';
import { Exam, Student, QuestionType, ViolationLog, Question } from '../../types';
import { gradeLocalAnswer, formatLocalAnswer } from '../../services/gradeClient';
import { CheckCircle, CheckCircle2, XCircle, Clock, Award, Send, Star, AlertTriangle, Loader2 } from 'lucide-react';
import { apiPost } from '../../services/api';

interface ExamResultProps {
  exam: Exam;
  student: Student;
  answers: Record<string, string | number>;
  violations: ViolationLog[];
  questions?: Question[]; // The specific subset taken
  sessionId?: number;
  // True while the final submission is still on its way to the server (first try or a retry).
  submitting?: boolean;
  // False when the final submission couldn't be confirmed by the server (e.g. a dropped network
  // request) — the score/review below is computed locally and may not match what's on record yet.
  submissionSynced?: boolean;
  resubmitting?: boolean;
  onRetrySubmission?: () => void;
}

// Module-level on purpose: a component declared inside ExamResult's body is a NEW component type
// on every render, so React unmounted/remounted it on each keystroke or star click (focus lost).
const StarRating = ({ label, value, onChange, disabled }: { label: string; value: number; onChange: (v: number) => void; disabled: boolean }) => (
  <div className="flex flex-col gap-1" role="group" aria-label={label}>
    <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</span>
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map(n => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          onClick={() => onChange(n)}
          aria-label={`${label}: ${n} of 5`}
          aria-pressed={n === value}
          className="rounded focus:outline-none disabled:cursor-default"
        >
          <Star
            size={22}
            className={n <= value ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}
          />
        </button>
      ))}
    </div>
  </div>
);

export const ExamResult: React.FC<ExamResultProps> = ({ exam, student, answers, questions, sessionId, submitting = false, submissionSynced = true, resubmitting = false, onRetrySubmission }) => {
  const questionsToGrade = questions || exam.questions;
  const showResults = exam.showResults ?? false;
  // Per-exam switch (exam editor → Candidate Feedback); exams saved before it existed ask for feedback.
  const feedbackEnabled = exam.feedbackEnabled !== false;
  const feedbackRef = useRef<HTMLDivElement>(null);
  // Only a confirmed submission is "completed" — until then the candidate must keep the page open.
  const completed = submissionSynced && !submitting;

  // Auto-scroll to feedback after a short delay so the student sees it.
  useEffect(() => {
    if (!feedbackEnabled) return;
    const t = window.setTimeout(() => {
      feedbackRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 800);
    return () => window.clearTimeout(t);
  }, [feedbackEnabled]);

  // Calculate Score
  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let pendingCount = 0;

  questionsToGrade.forEach(q => {
    maxScore += q.marks;
    const grade = gradeLocalAnswer(q, answers[q.id]);
    if (grade === 'pending') {
      // Free-text questions are graded manually; treated as 0 for the immediate auto-calc.
      pendingCount += 1;
    } else if (grade === 'correct') {
      score += q.marks;
      correctCount += 1;
    } else {
      // 'incorrect' (answered but wrong) may carry a penalty; 'unanswered' never does.
      if (grade === 'incorrect' && q.negativeMarks) {
        score -= q.negativeMarks;
      }
      incorrectCount += 1;
    }
  });

  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const passPercent = Math.max(0, Math.min(100, exam.passPercent ?? 60));
  // Same rule as the server (sessions.php 'complete': totalScore / maxScore >= passPercent / 100) on
  // the UNROUNDED ratio. Comparing the rounded percentage showed e.g. 39.6% as PASSED against a
  // 40% pass mark while the recorded result was FAIL.
  const passed = maxScore > 0 ? score / maxScore >= passPercent / 100 : percentage >= passPercent;
  // Manually-graded answers count as 0 until an examiner marks them, so a below-the-mark score is
  // only provisional while any are outstanding — don't announce "Failed" yet.
  const verdictPending = !passed && pendingCount > 0;
  const [rating, setRating] = useState(5);
  const [clarityRating, setClarityRating] = useState(5);
  const [platformRating, setPlatformRating] = useState(5);
  const [comment, setComment] = useState('');
  const [feedbackStatus, setFeedbackStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const submitFeedback = async () => {
    if (feedbackStatus === 'saving' || feedbackStatus === 'saved') return;
    setFeedbackStatus('saving');
    try {
      await apiPost('feedback.php', {
        examId: exam.id,
        studentId: student.id,
        sessionId: sessionId ?? null,
        rating,
        clarityRating,
        platformRating,
        comment,
      });
      setFeedbackStatus('saved');
    } catch (e) {
      console.error('Failed to submit feedback:', e);
      setFeedbackStatus('error');
    }
  };

  // Rendered via a plain function call ({renderFeedbackBox()}), NOT as <FeedbackBox />: as an inline
  // component it remounted on every state change, so the comment box lost focus after each
  // character typed.
  const renderFeedbackBox = () => !feedbackEnabled ? null : (
    <div ref={feedbackRef} className="p-6 border-t-2 border-blue-100 bg-blue-50/40">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
            <Star size={16} className="text-blue-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Share your feedback</h3>
            <p className="text-sm text-slate-500">Your input helps improve the exam and proctoring experience.</p>
          </div>
        </div>

        {feedbackStatus === 'saved' ? (
          <div className="flex items-center gap-2 text-teal-700 bg-teal-50 border border-teal-200 rounded-xl px-4 py-3">
            <CheckCircle size={18} className="text-teal-500" />
            <span className="text-sm font-medium">Thank you! Your feedback has been submitted.</span>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StarRating label="Overall Experience" value={rating} onChange={setRating} disabled={feedbackStatus === 'saving'} />
              <StarRating label="Question Clarity" value={clarityRating} onChange={setClarityRating} disabled={feedbackStatus === 'saving'} />
              <StarRating label="Platform Experience" value={platformRating} onChange={setPlatformRating} disabled={feedbackStatus === 'saving'} />
            </div>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              disabled={feedbackStatus === 'saving'}
              aria-label="Feedback comments (optional)"
              placeholder="Any comments about the exam, technical issues, or your experience? (optional)"
              className="min-h-20 w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm outline-none focus:border-blue-300 disabled:opacity-60 resize-none"
            />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              {feedbackStatus === 'error' && (
                <p role="alert" className="text-xs text-rose-600">Could not save feedback. Please try again.</p>
              )}
              <button
                type="button"
                onClick={submitFeedback}
                disabled={feedbackStatus === 'saving'}
                className="ml-auto inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                <Send size={14} /> {feedbackStatus === 'saving' ? 'Submitting…' : 'Submit Feedback'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  // Replaces the old "Return to Home" button: the candidate's journey ends here. Sending them to the
  // token-entry page after an exam only confused them.
  const renderCompletionFooter = () => (
    <div className="bg-slate-50 p-6 border-t border-slate-200 flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-center">
      <div role="status" className={`flex items-center gap-2 text-sm font-medium ${completed ? 'text-teal-700' : submitting ? 'text-slate-600' : 'text-amber-700'}`}>
        {completed ? <CheckCircle2 size={18} className="text-teal-500 shrink-0" />
          : submitting ? <Loader2 size={18} className="animate-spin shrink-0" />
          : <AlertTriangle size={18} className="text-amber-500 shrink-0" />}
        <span>
          {completed ? 'Your exam is completed. You can now close this window.'
            : submitting ? 'Submitting your answers… please keep this window open.'
            : 'Please keep this window open until your submission is confirmed.'}
        </span>
      </div>
      {/* Was a Math.random() string that changed on every re-render and matched nothing on
          record — useless (and misleading) if a candidate quoted it to support. */}
      {sessionId ? <div className="text-sm text-slate-500 font-mono">Session ID: {sessionId}</div> : null}
    </div>
  );

  const renderSyncWarningBanner = () => {
    if (submissionSynced) return null;
    return (
      <div role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 flex gap-3 items-start">
        <AlertTriangle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-900">Submission not yet confirmed</p>
          <p className="text-xs text-amber-800 mt-1">
            We couldn't reach the server to confirm your submission — the score below is calculated on your device only.
            Please stay on this page and retry, or contact your administrator if it keeps failing.
          </p>
          {onRetrySubmission && (
            <button
              type="button"
              onClick={onRetrySubmission}
              disabled={resubmitting}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-60"
            >
              {resubmitting ? 'Retrying…' : 'Retry Submission'}
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!showResults) {
    return (
      <div className="min-h-screen lsc-gradient-bg py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mx-auto">
          {renderSyncWarningBanner()}
          <div className="lsc-panel overflow-hidden">
            <div className="p-8 text-center bg-[radial-gradient(700px_circle_at_50%_0%,rgba(20,184,166,0.16),transparent_70%),linear-gradient(180deg,#f4fbfa,#eef6f4)] text-slate-900 border-b border-slate-200">
              <div className={`mx-auto mb-4 h-14 w-14 rounded-full flex items-center justify-center ${completed ? 'bg-teal-100 text-teal-600' : 'bg-slate-100 text-slate-500'}`}>
                {completed ? <CheckCircle2 size={30} /> : <Loader2 size={28} className={submitting ? 'animate-spin' : ''} />}
              </div>
              <h1 className="text-3xl font-bold mb-2">{completed ? 'Your exam is completed' : 'Submitting your exam'}</h1>
              <p className="text-slate-500">{exam.title} · {student.fullName}</p>
            </div>
            <div className="p-8 text-center">
              <p className="text-slate-700">
                {completed
                  ? 'Your answers have been submitted. Results will be shared after evaluation.'
                  : 'Your answers are saved. Please wait while we confirm your submission.'}
              </p>
            </div>
            {renderFeedbackBox()}
            {renderCompletionFooter()}
          </div>
        </div>
      </div>
    );
  }

  const gaugeRadius = 54;
  const gaugeCircumference = 2 * Math.PI * gaugeRadius;
  const gaugeOffset = gaugeCircumference * (1 - Math.max(0, Math.min(100, percentage)) / 100);
  const accent = passed ? '#14b8a6' : verdictPending ? '#2563eb' : '#f43f5e';

  return (
    <div className="min-h-screen lsc-gradient-bg py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-8">

        {renderSyncWarningBanner()}

        {/* Header Card */}
        <div className="lsc-panel overflow-hidden">
          <div className={`relative p-8 sm:p-10 text-center text-slate-900 border-b border-slate-200 ${passed
              ? 'bg-[radial-gradient(800px_circle_at_50%_-15%,rgba(20,184,166,0.18),transparent_70%),linear-gradient(180deg,#f2fbf9,#eef6f4)]'
              : verdictPending
                ? 'bg-[radial-gradient(800px_circle_at_50%_-15%,rgba(37,99,235,0.14),transparent_70%),linear-gradient(180deg,#f7faff,#eef3fb)]'
                : 'bg-[radial-gradient(800px_circle_at_50%_-15%,rgba(244,63,94,0.15),transparent_70%),linear-gradient(180deg,#fff7f7,#fdeef0)]'}`}>
            {completed && (
              <p className="mb-3 flex items-center justify-center gap-1.5 text-sm font-semibold text-slate-700">
                <CheckCircle2 size={16} className="text-teal-500" /> Your exam is completed
              </p>
            )}
            <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold tracking-wide ${passed ? 'bg-teal-100 text-teal-700' : verdictPending ? 'bg-blue-100 text-blue-700' : 'bg-rose-100 text-rose-700'}`}>
              {passed ? <CheckCircle size={13} /> : verdictPending ? <Clock size={13} /> : <XCircle size={13} />}
              {passed ? 'PASSED' : verdictPending ? 'PENDING EVALUATION' : 'FAILED'}
            </div>
            <h1 className="text-3xl font-bold mt-3 mb-1">{passed ? 'Examination Passed' : verdictPending ? 'Result Pending Evaluation' : 'Examination Failed'}</h1>
            <p className="text-slate-500">{exam.title} · {student.fullName}</p>
            {verdictPending && (
              <p className="mt-2 text-sm text-slate-600 max-w-xl mx-auto">
                {pendingCount === 1 ? '1 written answer is' : `${pendingCount} written answers are`} still to be marked by an examiner.
                The score below covers the auto-graded questions only; your final result will be confirmed after evaluation.
              </p>
            )}

            {/* Circular score gauge */}
            <div className="mt-8 flex flex-col items-center">
              <div className="relative w-40 h-40 sm:w-44 sm:h-44">
                <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
                  <circle cx="60" cy="60" r={gaugeRadius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
                  <circle
                    cx="60" cy="60" r={gaugeRadius} fill="none"
                    stroke={accent} strokeWidth="10" strokeLinecap="round"
                    strokeDasharray={gaugeCircumference}
                    strokeDashoffset={gaugeOffset}
                    style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(0.22,1,0.36,1)' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className={`text-5xl font-bold ${passed ? 'text-teal-600' : verdictPending ? 'text-blue-600' : 'text-rose-600'}`}>
                    {percentage}<span className="text-2xl align-top">%</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-widest text-slate-400 mt-1">Score</span>
                </div>
              </div>
              <p className="text-sm text-slate-500 mt-4 flex items-center gap-1.5">
                <Award size={15} className="text-slate-400" />
                <span><span className="font-semibold text-slate-700">{score}</span> / {maxScore} marks · pass mark {passPercent}%</span>
              </p>
            </div>

            {/* Stat tiles */}
            <div className="mt-8 grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-2xl mx-auto">
              <div className="rounded-2xl bg-white/70 backdrop-blur border border-slate-200 px-4 py-4">
                <div className="text-2xl font-bold text-slate-900">{questionsToGrade.length}</div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mt-0.5">Questions</div>
              </div>
              <div className="rounded-2xl bg-teal-50/80 backdrop-blur border border-teal-100 px-4 py-4">
                <div className="text-2xl font-bold text-teal-600">{correctCount}</div>
                <div className="text-[11px] uppercase tracking-wide text-teal-600/80 mt-0.5">Correct</div>
              </div>
              <div className="rounded-2xl bg-rose-50/80 backdrop-blur border border-rose-100 px-4 py-4">
                <div className="text-2xl font-bold text-rose-500">{incorrectCount}</div>
                {/* Counts wrong AND unanswered questions (matches the per-question badges below). */}
                <div className="text-[11px] uppercase tracking-wide text-rose-500/80 mt-0.5">Wrong / Skipped</div>
              </div>
              <div className="rounded-2xl bg-blue-50/80 backdrop-blur border border-blue-100 px-4 py-4">
                <div className="text-2xl font-bold text-blue-600">{pendingCount}</div>
                <div className="text-[11px] uppercase tracking-wide text-blue-600/80 mt-0.5">Pending</div>
              </div>
            </div>
          </div>

          {/* Detailed Review */}
          <div className="p-4 sm:p-8">
            <h3 className="text-xl font-bold text-slate-800 mb-6">Performance Breakdown</h3>
            <div className="space-y-6">
              {questionsToGrade.map((q, idx) => {
                const userAnswer = answers[q.id];
                const grade = gradeLocalAnswer(q, userAnswer);
                const isText = grade === 'pending';
                const isCorrect = grade === 'correct';
                // Option-based types keep the rich choice list; everything else uses a text summary.
                const isOptionType = q.type === QuestionType.MCQ || q.type === QuestionType.TRUE_FALSE || q.type === QuestionType.YES_NO;

                // Determine Marks Awarded and Status
                let marksAwarded: string | number = 0;
                let statusBadge = null;

                if (isText) {
                    marksAwarded = "Pending";
                    statusBadge = <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-700 border border-blue-200">MANUAL GRADING</span>;
                } else if (isCorrect) {
                    marksAwarded = q.marks;
                    statusBadge = <span className="text-xs font-bold px-2 py-0.5 rounded bg-teal-100 text-teal-700 border border-teal-200">CORRECT</span>;
                } else {
                    // Only an attempted-but-wrong answer carries the penalty; a skipped question stays 0.
                    if (grade === 'incorrect' && q.negativeMarks) {
                        marksAwarded = -q.negativeMarks;
                    }
                    // A skipped question was labelled INCORRECT, which read as a wrong answer.
                    statusBadge = grade === 'unanswered'
                      ? <span className="text-xs font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">NOT ANSWERED</span>
                      : <span className="text-xs font-bold px-2 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200">INCORRECT</span>;
                }

                return (
                  <div key={q.id} className={`border rounded-xl p-4 sm:p-6 transition-all ${isCorrect || isText ? 'bg-white border-slate-200 hover:border-slate-300' : 'bg-orange-50/50 border-orange-200'}`}>
                    <div className="flex gap-3 sm:gap-4">
                      <div className="flex-shrink-0 mt-1">
                        {isText ? (
                          <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center" title="Pending Grading">
                             <Clock size={16} />
                          </div>
                        ) : isCorrect ? (
                             <div className="w-8 h-8 rounded-full bg-teal-100 text-teal-600 flex items-center justify-center">
                             <CheckCircle size={18} />
                          </div>
                        ) : (
                          <div className="w-8 h-8 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center">
                             <XCircle size={18} />
                          </div>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                         {/* Wraps on phones: the title, status badge and marks pill used to overflow the card. */}
                         <div className="flex flex-wrap justify-between items-start gap-2 mb-3">
                           <div className="min-w-0">
                             <h4 className="font-medium text-slate-900 text-lg flex flex-wrap items-center gap-x-3 gap-y-1">
                                Question {idx+1}
                                {statusBadge}
                             </h4>
                           </div>
                           <div className="text-right">
                             <div className="text-sm font-semibold text-slate-900 flex items-center justify-end gap-1.5 bg-slate-100 px-3 py-1 rounded-full whitespace-nowrap">
                                <Award size={14} className="text-slate-500" />
                                <span>{marksAwarded} / {q.marks} Marks</span>
                             </div>
                           </div>
                         </div>
                         
                         <p className="text-slate-800 mb-5 leading-relaxed whitespace-pre-wrap">{q.text}</p>
                         
                         {isText ? (
                           <div className="bg-blue-50/50 p-4 rounded-lg border border-blue-100">
                             <h5 className="text-xs font-semibold text-blue-800 uppercase mb-2 flex items-center gap-1">
                                Your Answer
                             </h5>
                             <p className="text-slate-700 text-sm italic whitespace-pre-wrap">{userAnswer || "No answer provided."}</p>
                           </div>
                         ) : isOptionType ? (
                           <div className="space-y-2">
                             {q.options?.map((opt, i) => {
                               const selected = userAnswer === i;
                               const correct = q.correctOptionIndex === i;

                               let containerStyle = "border-slate-200 bg-slate-50 text-slate-600";
                               let icon = null;

                               if (correct) {
                                  containerStyle = "border-teal-200 bg-teal-50 text-teal-900 font-medium ring-1 ring-teal-200";
                                  icon = <CheckCircle size={16} className="text-teal-600" />;
                               } else if (selected && !correct) {
                                  containerStyle = "border-orange-200 bg-orange-50 text-orange-900 ring-1 ring-orange-200";
                                  icon = <XCircle size={16} className="text-orange-600" />;
                               }

                               return (
                                 <div key={i} className={`px-4 py-3 rounded-lg border text-sm flex justify-between items-center ${containerStyle}`}>
                                   <div className="flex items-center gap-3">
                                      <span className={`w-6 h-6 rounded-full border flex items-center justify-center text-xs font-mono ${correct || selected ? 'border-transparent bg-white/50' : 'border-slate-300 bg-white'}`}>
                                        {String.fromCharCode(65+i)}
                                      </span>
                                      <span>{opt}</span>
                                   </div>
                                   <div className="flex items-center gap-2">
                                      {selected && <span className="text-[10px] uppercase font-bold tracking-widest opacity-60">Your Answer</span>}
                                      {icon}
                                   </div>
                                 </div>
                               )
                             })}
                           </div>
                         ) : (
                           (() => {
                             const { yours, correct } = formatLocalAnswer(q, userAnswer);
                             return (
                               <div className="grid gap-2 sm:grid-cols-2">
                                 <div className={`p-4 rounded-lg border ${isCorrect ? 'bg-teal-50/60 border-teal-200' : 'bg-orange-50/60 border-orange-200'}`}>
                                   <h5 className="text-xs font-semibold uppercase mb-2 text-slate-500">Your Answer</h5>
                                   <p className="text-slate-800 text-sm whitespace-pre-wrap">{yours || 'No answer provided.'}</p>
                                 </div>
                                 <div className="p-4 rounded-lg border bg-slate-50 border-slate-200">
                                   <h5 className="text-xs font-semibold uppercase mb-2 text-slate-500">Correct Answer</h5>
                                   <p className="text-slate-800 text-sm whitespace-pre-wrap">{correct || '—'}</p>
                                 </div>
                               </div>
                             );
                           })()
                         )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          {renderFeedbackBox()}
          {renderCompletionFooter()}
        </div>
      </div>
    </div>
  );
};



