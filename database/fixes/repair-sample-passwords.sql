-- Development sample accounts only. Preserve all nonmatching or already-hashed accounts.
BEGIN;
UPDATE public."user" AS u SET password=v.hashed
FROM (VALUES
(1,'johndoe@example.com','johndoe','$2b$12$H3kmbSt8hzszu0IwGybgdu0JXuOvUM7k7BQ.7hXYt1ciZWkG0aF5m'),
(2,'janesmith@example.com','janesmith','$2b$12$dVAhgCB9s89Zcho02kgq0e6Mnh/65G0E9SwcmOKy.Oqtt0NSTmnOG'),
(3,'JDeen1999@gmail.com','1!J$$D!@','$2b$12$f4j/j5Srkvr0OwL9W5bn2exXtQgZb2plgS/kS1VzuURwvzAqMhD5i'),
(4,'RoseyM@gmail.com','MaryLamb428','$2b$12$WZrJHSH9jhzOvJ4fev//les/5fZAsICc37Jl/wQWXt6lJkoGhXQTS'),
(5,'MarkBar13@yahoo.com','mYp@ssw0rd111','$2b$12$bNnPJC9C7yDSttF2Q4sW8.gjenA.T1.iRkWX.2DSXImFzMhDyFF66'),
(6,'KatKat@yahoo.com','123barry987','$2b$12$reXiTfL/2eCJYo/4Bb.ZX.Upf/TA4Nf.T6i76oJ2J/13uuhHHbXW.')
) AS v(userid,email,original,hashed)
WHERE u.userid=v.userid AND u.email=v.email AND u.password=v.original;
COMMIT;
