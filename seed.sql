-- Mock Feedback Data for Testing
INSERT INTO feedback (source, text, sentiment, themes, urgency, created_at) VALUES
-- GitHub Issues
('GitHub', 'The API response time is extremely slow, taking over 5 seconds to load. This is blocking our production deployment.', NULL, NULL, NULL, datetime('now', '-5 days')),
('GitHub', 'Love the new dashboard UI! The dark mode looks fantastic and the navigation is much more intuitive.', NULL, NULL, NULL, datetime('now', '-4 days')),
('GitHub', 'Documentation is missing examples for the authentication flow. Spent 3 hours trying to figure it out.', NULL, NULL, NULL, datetime('now', '-4 days')),
('GitHub', 'Feature request: Add support for bulk operations. Would save us tons of time with large datasets.', NULL, NULL, NULL, datetime('now', '-3 days')),
('GitHub', 'Critical bug: Users are getting 500 errors when trying to upload files larger than 10MB.', NULL, NULL, NULL, datetime('now', '-3 days')),

-- Discord Messages
('Discord', 'hey anyone else experiencing crashes on the mobile app? happens every time i try to export data', NULL, NULL, NULL, datetime('now', '-5 days')),
('Discord', 'The customer support team is amazing! Got my issue resolved in under 10 minutes.', NULL, NULL, NULL, datetime('now', '-4 days')),
('Discord', 'pricing seems really high compared to competitors. any student discounts available?', NULL, NULL, NULL, datetime('now', '-3 days')),
('Discord', 'This platform has completely transformed our workflow. Best decision we made this year!', NULL, NULL, NULL, datetime('now', '-2 days')),
('Discord', 'Search functionality is broken - keeps returning irrelevant results', NULL, NULL, NULL, datetime('now', '-2 days')),

-- Twitter/X
('Twitter', 'Been using @product for 2 weeks now. The performance improvements in v2.0 are incredible! 🚀', NULL, NULL, NULL, datetime('now', '-5 days')),
('Twitter', '@product your app keeps logging me out every 5 minutes. super frustrating when trying to work', NULL, NULL, NULL, datetime('now', '-4 days')),
('Twitter', 'Why is there no way to export data to CSV? This should be a basic feature @product', NULL, NULL, NULL, datetime('now', '-3 days')),
('Twitter', 'Shoutout to @product for having the cleanest API documentation I''ve ever used. Seriously top-notch.', NULL, NULL, NULL, datetime('now', '-2 days')),
('Twitter', '@product URGENT: Payment processing is down. Cannot complete transactions. Need fix ASAP!', NULL, NULL, NULL, datetime('now', '-1 day')),

-- Support Tickets
('Support Ticket', 'I cannot access my account after the recent update. Keep getting "Invalid credentials" error even though my password is correct.', NULL, NULL, NULL, datetime('now', '-5 days')),
('Support Ticket', 'The integration with Salesforce is not syncing properly. Data from last week is still missing.', NULL, NULL, NULL, datetime('now', '-4 days')),
('Support Ticket', 'Excellent service! Your team helped migrate all our data smoothly. Very impressed with the onboarding process.', NULL, NULL, NULL, datetime('now', '-3 days')),
('Support Ticket', 'Webhook notifications are not being delivered. Checked our endpoint and it''s working fine on our side.', NULL, NULL, NULL, datetime('now', '-2 days')),
('Support Ticket', 'Security concern: Found that API keys are visible in browser console. This needs to be fixed immediately.', NULL, NULL, NULL, datetime('now', '-1 day')),

-- Email Feedback
('Email', 'We are a team of 50 and would like to upgrade to enterprise plan. What are the pricing options and custom features available?', NULL, NULL, NULL, datetime('now', '-5 days')),
('Email', 'The recent UI redesign is terrible. Everything takes more clicks now and features are harder to find. Please bring back the old interface.', NULL, NULL, NULL, datetime('now', '-4 days')),
('Email', 'Suggestion: Add keyboard shortcuts for common actions. Would make power users much more productive.', NULL, NULL, NULL, datetime('now', '-3 days')),
('Email', 'Your platform has reduced our operational costs by 40%. Thank you for building such an amazing product!', NULL, NULL, NULL, datetime('now', '-2 days')),
('Email', 'Accessibility issue: Screen reader support is very poor. Many buttons and forms are not properly labeled.', NULL, NULL, NULL, datetime('now', '-1 day')),

-- Forum Posts
('Forum', 'Tutorial: Here is how I set up automated backups using the API. Hope this helps others!', NULL, NULL, NULL, datetime('now', '-4 days')),
('Forum', 'Is there a way to customize the email templates? Can''t find this option in settings.', NULL, NULL, NULL, datetime('now', '-3 days')),
('Forum', 'Warning: Don''t upgrade to v2.1 yet. It breaks compatibility with legacy integrations.', NULL, NULL, NULL, datetime('now', '-2 days')),
('Forum', 'Rate limiting is too aggressive. Getting blocked after just 100 API calls per minute.', NULL, NULL, NULL, datetime('now', '-1 day')),
('Forum', 'This community is so helpful! Got answers to all my questions within hours. Loving the product and the support.', NULL, NULL, NULL, datetime('now', '-1 day'));
