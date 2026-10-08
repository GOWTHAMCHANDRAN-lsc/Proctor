import React from 'react';
import { UserRole } from '../../types';

interface QuestionBankProps {
  role: UserRole;
}

// Question Bank tab: company-owned, reusable question collections (see api/question_banks.php).
export const QuestionBank: React.FC<QuestionBankProps> = () => (
  <div className="lsc-page">
    <h1 className="lsc-title">Question Bank</h1>
  </div>
);
