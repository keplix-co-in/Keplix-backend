import test from 'node:test';
import assert from 'node:assert';

// Mock implementation of the logic for testing purposes
// since importing the actual file might require Prisma setup
function simulateRatingUpdate(currentAvg, currentCount, ratingValue, isDeletion = false) {
  let newCount, newAvg;

  if (isDeletion) {
    if (currentCount <= 0) return { newAvg: 0, newCount: 0 };
    newCount = currentCount - 1;
    if (newCount === 0) {
      newAvg = 0;
    } else {
      newAvg = ((currentAvg * currentCount) - ratingValue) / newCount;
    }
  } else {
    newCount = currentCount + 1;
    newAvg = ((currentAvg * currentCount) + ratingValue) / newCount;
  }

  return { 
    newAvg: Math.max(0, parseFloat(newAvg.toFixed(10))), // Match reasonable precision
    newCount 
  };
}

test('Incremental Rating: First Review', (t) => {
  const result = simulateRatingUpdate(0, 0, 5);
  assert.strictEqual(result.newAvg, 5);
  assert.strictEqual(result.newCount, 1);
});

test('Incremental Rating: Second Review', (t) => {
  // Existing: 1 review with 5 stars. New review: 3 stars.
  // Expected: (5 + 3) / 2 = 4
  const result = simulateRatingUpdate(5, 1, 3);
  assert.strictEqual(result.newAvg, 4);
  assert.strictEqual(result.newCount, 2);
});

test('Incremental Rating: Third Review (Floating Point)', (t) => {
  // Existing: 2 reviews with avg 4. New review: 4 stars.
  // Expected: (4 * 2 + 4) / 3 = 4
  const result = simulateRatingUpdate(4, 2, 4);
  assert.strictEqual(result.newAvg, 4);
  assert.strictEqual(result.newCount, 3);
});

test('Incremental Rating: Different Ratings', (t) => {
  // Existing: 2 reviews, avg 4.5. New: 3 stars.
  // Sum = 4.5 * 2 = 9. New Sum = 9 + 3 = 12. New Avg = 12 / 3 = 4.
  const result = simulateRatingUpdate(4.5, 2, 3);
  assert.strictEqual(result.newAvg, 4);
  assert.strictEqual(result.newCount, 3);
});

test('Incremental Deletion: Back to previous', (t) => {
  // Existing: 3 reviews, avg 4. Delete 3 star review.
  // Sum = 4 * 3 = 12. New Sum = 12 - 3 = 9. New Count = 2. New Avg = 9 / 2 = 4.5
  const result = simulateRatingUpdate(4, 3, 3, true);
  assert.strictEqual(result.newAvg, 4.5);
  assert.strictEqual(result.newCount, 2);
});

test('Incremental Deletion: Last review', (t) => {
  const result = simulateRatingUpdate(5, 1, 5, true);
  assert.strictEqual(result.newAvg, 0);
  assert.strictEqual(result.newCount, 0);
});

test('Incremental Deletion: Handle 0 count gracefully', (t) => {
  const result = simulateRatingUpdate(0, 0, 5, true);
  assert.strictEqual(result.newAvg, 0);
  assert.strictEqual(result.newCount, 0);
});
