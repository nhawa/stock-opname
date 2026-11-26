# Implementation Notes — Stock Opname Management System

## 1. Design Decisions and Interpretation

### Architecture and Inventory Model

This project using Express.js, TypeScript, Next.js, and PostgreSQL as that stack already enaough and soutable for the task. modular monolith is suitable for the project scope and potential user that does not require microservices at this stage. per-store inventory is choosed because the stock opname needed perstore but still can be analized globaly. 

### Session Initiation and Stock Snapshot

Session need initiated because stock snapshot need to captured and cannot be automated because operational for every store can be different each other, snapshots is taken when manager initiating opname session and will be used for stock calculation when manager approve staff physical count submission. The system only accept one active session per store to prefent misscalculation and race condition.

### Physical Counting and Submission

Staff can imediatly doing physical counting by clicking reserve button on spesific product that staff will count when manager start opname session. staff can doing batch counting and than save draft. after finish counting and save draft the staff can submit the count, after that the form cannot be edited. different staff can chose to count few different product by reserving that product and said product cannot be counted by other staff.

### Movement Reconciliation

there is stock movement feature on this project. stock movement can happen outside and within stock opname session. we encourage doing it outside opname session because misscalculation can be happen if not handled properly. for stock movement within stock opname session need more attention. if stock movement happen after staff save draft of phisical count the system will saving cutoff for ledger inventory position adjust the stock accordingly by snapshot data, movement stock, cutoff position and phisical count. if stock movement happen before the staff finishing save draft that additional stock has to be counted into submission phisical count.

## 2. Approval Workflow and Failure Handling

### Approval Process

after staff submitting physical count the status session will be changed into pending approval. after manager review the count submission, the manager can either reject or approve the submission. for both action system will validate role, store posession and session status, after that db transaction is initiated, session is locked, system then doing stock calculation with inventory balance, movement history, cutoff position and physical count submitted. movement adjustmen created and inventory updated, session status updated to approved and transaction commited. for rejection manager have to fill the reason form but the inventory will not be updated, manager can initate another session after that. for approval the submission will be used for stock calculation and will be updated into inventory.

### Failure Scenarios

database failure already implement transaction so if there is a failure when approval happen. all change on data on that transaction will be rolled back. concurrent approval handled with SERIALIZABLE session locking, status validation and unique database constraint, 1 session will success and other will return 409. 

## 3. Uncounted Products

if staff submit null value its mean the product is not counted therefor that product will be excepted for calculation, for zero value its mean the product is empty, for minus quantity system will reject it and only accept and proceed 0 and positif value. there is also validation when there is no any physical count submitted, minimum 1 product is filled.

## 4. Edge Cases and Their Handling

- approval button or api hit twice. this case handled with SERIALIZABLE and only on request is processed
- error happen midway of stock calculation. for this case update handled inside transaction and all update will be rolled back.
- there is stock adjustmen within stock opname session. this case handled with movement reconciliation that explained above.
- staff submit negatif value or excesive number. for this case system add validation that will reject submission

## 5. One Important Additional Feature

stock reservation by staff when doing physical count. this feature solve the problem when there is more staff doung phisical count so there is no overlapping when doing phisical count. 
i have alse added stock adjustmen for this project for adding or subside the quantity of product. this feature can be deleted or updated if company already has similiar fiture or there is already system that manage inventory. there is also simple view to see movement history, this view can be improved further to help better analitical review
