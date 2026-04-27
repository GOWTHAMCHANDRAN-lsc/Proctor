import React, { useState } from 'react';
import { Exam, Student, QuestionType, ViolationLog, Question } from '../../types';
import { CheckCircle, XCircle, Home, Clock, Award, Send } from 'lucide-react';
import { apiPost } from '../../services/api';

interface ExamResultProps {
  exam: Exam;
  student: Student;
  answers: Record<string, string | number>;
  violations: ViolationLog[];
  questions?: Question[]; // The specific subset taken
  sessionId?: number;
  onExit: () => void;
}

export const ExamResult: React.FC<ExamResultProps> = ({ exam, student, answers, questions, sessionId, onExit }) => {
  // Use the questions passed (subset) or fall back to exam.questions (all) for backward compatibility
  const questionsToGrade = questions || exam.questions;
  const showResults = exam.showResults ?? false;

  // Calculate Score
  let score = 0;
  let maxScore = 0;
  
  questionsToGrade.forEach(q => {
    maxScore += q.marks;
    if (q.type === QuestionType.MCQ) {
      if (answers[q.id] === q.correctOptionIndex) {
        score += q.marks;
      }
    }
    // Text questions are graded manually, treated as 0 for immediate auto-calc
  });

  const percentage = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
  const passPercent = Math.max(0, Math.min(100, exam.passPercent ?? 60));
  const passed = percentage >= passPercent;
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

  const FeedbackBox = () => (
    <div className="p-6 border-t border-slate-200 bg-white">
      <div className="flex flex-col gap-4">
        <div>
          <h3 className="text-lg font-semibold text-slate-900">Quick feedback</h3>
          <p className="text-sm text-slate-500 mt-1">Help the exam team improve the assessment and proctoring experience.</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {[
            ['Overall', rating, setRating],
            ['Question clarity', clarityRating, setClarityRating],
            ['Platform experience', platformRating, setPlatformRating],
          ].map(([label, value, setter]) => (
            <label key={String(label)} className="text-sm">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{String(label)}</span>
              <select
                value={Number(value)}
                onChange={e => (setter as React.Dispatch<React.SetStateAction<number>>)(Number(e.target.value))}
                disabled={feedbackStatus === 'saved'}
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none disabled:opacity-60"
              >
                {[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{n} / 5</option>)}
              </select>
            </label>
          ))}
        </div>
        <textarea
          value={comment}
          onChange={e => setComment(e.target.value)}
          disabled={feedbackStatus === 'saved'}
          placeholder="Optional comments about exam clarity, technical issues, or proctoring experience..."
          className="min-h-24 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm outline-none focus:border-blue-300 disabled:opacity-60"
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className={`text-xs ${
            feedbackStatus === 'saved' ? 'text-teal-600' : feedbackStatus === 'error' ? 'text-rose-600' : 'text-slate-400'
          }`}>
            {feedbackStatus === 'saved'
              ? 'Feedback submitted. Thank you.'
              : feedbackStatus === 'error'
                ? 'Could not save feedback. Please try again.'
                : 'Your feedback is linked to this exam, student, and batch.'}
          </p>
          <button
            type="button"
            onClick={submitFeedback}
            disabled={feedbackStatus === 'saving' || feedbackStatus === 'saved'}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            <Send size={14} /> {feedbackStatus === 'saving' ? 'Submitting...' : feedbackStatus === 'saved' ? 'Submitted' : 'Submit Feedback'}
          </button>
        </div>
      </div>
    </div>
  );

  if (!showResults) {
    return (
      <div className="min-h-screen lsc-gradient-bg py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl mx-auto">
          <div className="lsc-panel overflow-hidden">
            <div className="p-8 text-center bg-[radial-gradient(700px_circle_at_50%_0%,rgba(53,88,255,0.18),transparent_70%),linear-gradient(180deg,#f9fbff,#eef3fb)] text-slate-900 border-b border-slate-200">
              <h1 className="text-3xl font-bold mb-2">Thank you</h1>
              <p className="text-slate-500">{exam.title} - {student.fullName}</p>
            </div>
            <div className="p-8 text-center">
              <p className="text-gray-700">
                Your submission has been recorded. Results will be shared after evaluation.
              </p>
            </div>
            <FeedbackBox />
            <div className="bg-slate-50 p-6 border-t border-slate-200 flex justify-center">
              <button 
                onClick={onExit}
                className="px-6 py-2 lsc-button-primary flex items-center gap-2"
              >
                <Home size={18} /> Return to Home
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen lsc-gradient-bg py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-8">
        
        {/* Header Card */}
        <div className="lsc-panel overflow-hidden">
          <div className={`p-8 text-center ${passed ? 'bg-teal-50' : 'bg-orange-50'} text-slate-900 border-b border-slate-200`}>
            <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-semibold ${passed ? 'bg-teal-100 text-teal-700' : 'bg-orange-100 text-orange-700'}`}>
              {passed ? 'PASSED' : 'FAILED'}
            </div>
            <h1 className="text-3xl font-bold mt-3 mb-2">{passed ? 'Examination Passed' : 'Examination Failed'}</h1>
            <p className="text-slate-500">{exam.title} - {student.fullName}</p>
            
            <div className="mt-8 flex justify-center gap-12">
              <div className="text-center">
                <div className="text-4xl font-bold mb-1">{score} <span className="text-xl text-slate-400">/ {maxScore}</span></div>
                <div className="text-sm text-slate-500 uppercase tracking-wide">Total Score</div>
              </div>
              <div className="text-center">
                <div className="text-4xl font-bold mb-1">{percentage}%</div>
                <div className="text-sm text-slate-500 uppercase tracking-wide">Percentage</div>
              </div>
            </div>
          </div>

          {/* Detailed Review */}
          <div className="p-8">
            <h3 className="text-xl font-bold text-gray-800 mb-6">Performance Breakdown</h3>
            <div className="space-y-6">
              {questionsToGrade.map((q, idx) => {
                const userAnswer = answers[q.id];
                const isCorrect = userAnswer === q.correctOptionIndex;
                const isText = q.type === QuestionType.TEXT;
                
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
                    statusBadge = <span className="text-xs font-bold px-2 py-0.5 rounded bg-orange-100 text-orange-700 border border-orange-200">INCORRECT</span>;
                }

                return (
                  <div key={q.id} className={`border rounded-xl p-6 transition-all ${isCorrect || isText ? 'bg-white border-gray-200 hover:border-gray-300' : 'bg-orange-50/50 border-orange-200'}`}>
                    <div className="flex gap-4">
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
                      <div className="flex-1">
                         <div className="flex justify-between items-start mb-3">
                           <div>
                             <h4 className="font-medium text-gray-900 text-lg flex items-center gap-3">
                                Question {idx+1}
                                {statusBadge}
                             </h4>
                           </div>
                           <div className="text-right">
                             <div className="text-sm font-semibold text-gray-900 flex items-center justify-end gap-1.5 bg-gray-100 px-3 py-1 rounded-full">
                                <Award size={14} className="text-gray-500" />
                                <span>{marksAwarded} / {q.marks} Marks</span>
                             </div>
                           </div>
                         </div>
                         
                         <p className="text-gray-800 mb-5 leading-relaxed whitespace-pre-wrap">{q.text}</p>
                         
                         {isText ? (
                           <div className="bg-blue-50/50 p-4 rounded-lg border border-blue-100">
                             <h5 className="text-xs font-semibold text-blue-800 uppercase mb-2 flex items-center gap-1">
                                Your Answer
                             </h5>
                             <p className="text-gray-700 text-sm italic whitespace-pre-wrap">{userAnswer || "No answer provided."}</p>
                           </div>
                         ) : (
                           <div className="space-y-2">
                             {q.options?.map((opt, i) => {
                               const selected = userAnswer === i;
                               const correct = q.correctOptionIndex === i;
                               
                               let containerStyle = "border-gray-200 bg-slate-50 text-gray-600";
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
                                      <span className={`w-6 h-6 rounded-full border flex items-center justify-center text-xs font-mono ${correct || selected ? 'border-transparent bg-white/50' : 'border-gray-300 bg-white'}`}>
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
                         )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Footer */}
          <FeedbackBox />
          <div className="bg-slate-50 p-6 border-t border-slate-200 flex flex-col gap-3 sm:flex-row sm:justify-between sm:items-center">
             <div className="text-sm text-slate-500 font-mono">
               Session ID: {Math.random().toString(36).substr(2, 12).toUpperCase()}
             </div>
             <button 
               onClick={onExit}
               className="px-6 py-2 lsc-button-primary flex items-center gap-2"
             >
               <Home size={18} /> Return to Home
             </button>
          </div>
        </div>
      </div>
    </div>
  );
};



