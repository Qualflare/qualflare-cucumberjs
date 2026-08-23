import { Given } from '@cucumber/cucumber';

Given('a step with the following table:', function (dataTable) {
  this.table = dataTable.raw();
});

Given('a step with the following text:', function (docString) {
  this.doc = docString;
});
