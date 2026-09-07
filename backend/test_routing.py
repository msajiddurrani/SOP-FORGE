import asyncio
import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
from dotenv import load_dotenv
load_dotenv()
from agent import evaluate_intent_and_routing

async def main():
    test_cases = [
        ("Hello", "respond", None),
        ("My computer is showing a blue screen error", "transfer", "IT_Support"),
        ("Mera laptop start nahi ho raha IT se connect karo", "transfer", "IT_Support"),
        ("Salary nahi aayi abhi tak", "transfer", "Accounts_Finance"),
        ("Leave policy kya hai?", "transfer", "General_HR"),
        ("नमस्ते मुझे मदद चाहिए", "respond", None),
    ]
    
    passed = 0
    failed = 0
    
    for user_input, expected_action, expected_dept in test_cases:
        print(f"\n{'='*50}")
        print(f"User: {user_input}")
        print(f"Expected: action={expected_action}, dept={expected_dept}")
        
        try:
            res = await evaluate_intent_and_routing(user_input, [])
            action = res['action']
            dept = res['target_department']
            text = res['response_text']
            
            print(f"Got:      action={action}, dept={dept}")
            print(f"Response: {text}")
            
            action_ok = action == expected_action
            dept_ok = (expected_dept is None and dept is None) or dept == expected_dept
            
            if action_ok and dept_ok:
                print("[PASS]")
                passed += 1
            else:
                print("[FAIL]")
                failed += 1
                
        except Exception as e:
            print(f"[ERROR]: {e}")
            failed += 1
        
        # Small delay to avoid rate limits
        await asyncio.sleep(3)
    
    print(f"\n{'='*50}")
    print(f"Results: {passed} passed, {failed} failed out of {len(test_cases)}")

if __name__ == "__main__":
    asyncio.run(main())
